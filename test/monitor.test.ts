import test from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MetricsCollector, type ServerMetrics } from '../dist/core/metrics.js';
import { SplitSession } from '../dist/core/split-session.js';
import { SidebarRenderer, defaultSidebarTheme } from '../dist/tui/sidebar.js';
import { padClip, stringWidth } from '../dist/tui/screen.js';
import { InteractiveSession } from '../dist/core/session.js';

function mockChannel() {
  return Object.assign(new EventEmitter(), {
    stderr: new EventEmitter(),
    setWindow() {},
    write() {},
    close() {}
  });
}

function flushPoll() {
  return new Promise<void>(resolve => setImmediate(resolve));
}

test('MetricsCollector: rejected probes are non-fatal and stale samples are discarded', async (context) => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const requests: ((error?: Error, channel?: ReturnType<typeof mockChannel>) => void)[] = [];
  const collector = new MetricsCollector(Object.assign(new EventEmitter(), {
    exec(_command: string, _options: unknown, callback: typeof requests[number]) {
      requests.push(callback);
    }
  }) as any, 25);
  const updated = context.mock.fn();
  collector.on('update', updated);

  function completeSample(callback: typeof requests[number], hostname: string) {
    const channel = mockChannel();
    callback(undefined, channel);
    channel.emit('data', Buffer.from(`HOST=${hostname}\n`));
    channel.emit('exit', 0);
    channel.emit('close');
  }

  try {
    collector.start();
    requests.shift()!(new Error('metrics unavailable'));
    await flushPoll();

    context.mock.timers.tick(25);
    const staleRequest = requests.shift()!;
    collector.stop();
    collector.start();
    completeSample(staleRequest, 'stale');
    await flushPoll();
    assert.strictEqual(updated.mock.callCount(), 0);

    context.mock.timers.tick(25);
    completeSample(requests.shift()!, 'current');
    await flushPoll();
    assert.strictEqual(updated.mock.callCount(), 1);
    assert.strictEqual(collector.getLatest()?.hostname, 'current');
  } finally {
    collector.stop();
  }
});

test('SplitSession: sidebar polling follows visibility and stops at session close', async (context) => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const input = Object.assign(new EventEmitter(), { isTTY: true, setRawMode() {}, pause() {}, resume() {} });
  const write = context.mock.fn((_text: string) => true);
  const output = Object.assign(new EventEmitter(), { isTTY: true, columns: 110, rows: 30, write });
  context.mock.getter(process, 'stdin', () => input as unknown as typeof process.stdin);
  context.mock.getter(process, 'stdout', () => output as unknown as typeof process.stdout);
  const channel = mockChannel();
  const exec = context.mock.fn((_command, _options, callback) => callback(new Error('metrics unavailable')));
  const session = new SplitSession(Object.assign(new EventEmitter(), {
    exec,
    shell(_options: unknown, callback: (error: undefined, channel: ReturnType<typeof mockChannel>) => void) {
      callback(undefined, channel);
    }
  }) as any, { enableSidebar: false });

  await session.start();
  try {
    session.attachToLocalProcess();
    assert.strictEqual(exec.mock.callCount(), 0);

    input.emit('data', Buffer.from('\x1b[12~'));
    assert.strictEqual(exec.mock.callCount(), 1);
    await flushPoll();
    assert.ok(write.mock.calls.some(call => call.arguments[0].includes('Metrics unavailable')));
    context.mock.timers.tick(2500);
    assert.strictEqual(exec.mock.callCount(), 2);

    output.columns = 80;
    output.emit('resize');
    await flushPoll();
    context.mock.timers.tick(5000);
    assert.strictEqual(exec.mock.callCount(), 2);

    // Default toggleHotkey ('f2') leaves Ctrl+O (\x0f) forwarded to the shell
    input.emit('data', Buffer.from('\x0f'));
    assert.strictEqual(exec.mock.callCount(), 2);

    input.emit('data', Buffer.from('\x1bOQ'));
    assert.strictEqual(exec.mock.callCount(), 3);
  } finally {
    channel.emit('close');
  }
  await flushPoll();
  context.mock.timers.tick(5000);
  assert.strictEqual(exec.mock.callCount(), 3);
});

test('SplitSession: toggleHotkey f2+ctrl-o allows Ctrl+O to toggle sidebar', async (context) => {
  const input = Object.assign(new EventEmitter(), { isTTY: true, setRawMode() {}, pause() {}, resume() {} });
  const output = Object.assign(new EventEmitter(), { isTTY: true, columns: 110, rows: 30, write() {} });
  context.mock.getter(process, 'stdin', () => input as unknown as typeof process.stdin);
  context.mock.getter(process, 'stdout', () => output as unknown as typeof process.stdout);
  const channel = mockChannel();
  const exec = context.mock.fn((_command, _options, callback) => callback(new Error('metrics unavailable')));
  const session = new SplitSession(Object.assign(new EventEmitter(), {
    exec,
    shell(_options: unknown, callback: (error: undefined, channel: ReturnType<typeof mockChannel>) => void) {
      callback(undefined, channel);
    }
  }) as any, { enableSidebar: false, toggleHotkey: 'f2+ctrl-o' });

  await session.start();
  try {
    session.attachToLocalProcess();
    input.emit('data', Buffer.from('\x0f'));
    assert.strictEqual(exec.mock.callCount(), 1);
  } finally {
    channel.emit('close');
  }
});

test('SplitSession: redirected output disables sidebar polling and leaves hotkeys as input', async (context) => {
  const rawModes: boolean[] = [];
  const pauses = context.mock.fn();
  const input = Object.assign(new EventEmitter(), {
    isTTY: true,
    isRaw: false,
    isPaused: () => true,
    setRawMode: (raw: boolean) => rawModes.push(raw),
    pause: pauses,
    resume() {}
  });
  const output = Object.assign(new EventEmitter(), { isTTY: false, columns: 110, rows: 30, write() {} });
  context.mock.getter(process, 'stdin', () => input as unknown as typeof process.stdin);
  context.mock.getter(process, 'stdout', () => output as unknown as typeof process.stdout);
  const channel = mockChannel();
  const write = context.mock.method(channel, 'write');
  const exec = context.mock.fn();
  const session = new SplitSession({
    exec,
    shell(_options: unknown, callback: (error: undefined, channel: ReturnType<typeof mockChannel>) => void) {
      callback(undefined, channel);
    }
  } as any, { enableSidebar: true });

  await session.start();
  try {
    session.attachToLocalProcess();
    const hotkey = Buffer.from('\x0f');
    input.emit('data', hotkey);
    assert.strictEqual(exec.mock.callCount(), 0);
    assert.deepStrictEqual(write.mock.calls[0].arguments, [hotkey]);
  } finally {
    channel.emit('close');
  }
  assert.deepStrictEqual(rawModes, [true, false]);
  assert.strictEqual(pauses.mock.callCount(), 1);
});

test('InteractiveSession: coalesces shell startup and cancels a pending startup on close', async () => {
  const channel = mockChannel();
  let shellCalls = 0;
  const client = {
    shell: (_options: unknown, callback: (error: Error | undefined, stream: ReturnType<typeof mockChannel>) => void) => {
      shellCalls++;
      callback(undefined, channel);
    }
  };
  const session = new InteractiveSession(client as any);
  const [first, second] = await Promise.all([session.start(), session.start()]);
  assert.strictEqual(first, channel);
  assert.strictEqual(second, channel);
  assert.strictEqual(session.running(), true);
  assert.strictEqual(shellCalls, 1);
  channel.emit('close');

  let finishStartup: ((error: Error | undefined, stream: ReturnType<typeof mockChannel>) => void) | undefined;
  const pendingSession = new InteractiveSession({
    shell(_options: unknown, callback: typeof finishStartup) {
      finishStartup = callback;
    }
  } as any);
  const opening = pendingSession.start();
  pendingSession.close();
  const pendingChannel = mockChannel();
  finishStartup!(undefined, pendingChannel);
  await assert.rejects(opening, /closed before shell startup completed/);
  assert.strictEqual(pendingSession.running(), false);
});

test('InteractiveSession: closes the shell channel when recording cannot be initialized', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sshx-session-recording-error-'));
  const blocker = path.join(root, 'not-a-directory');
  fs.writeFileSync(blocker, 'file');
  const channel = mockChannel();
  let closeCalls = 0;
  channel.close = () => { closeCalls++; };
  const session = new InteractiveSession({
    shell(_options: unknown, callback: (error: undefined, stream: ReturnType<typeof mockChannel>) => void) {
      callback(undefined, channel);
    }
  } as any, { recordFilePath: path.join(blocker, 'session.cast') });

  try {
    await assert.rejects(session.start(), /EEXIST|not a directory/i);
    assert.strictEqual(closeCalls, 1);
    assert.strictEqual(session.running(), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('InteractiveSession: records output with owner-only file permissions', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sshx-session-recording-success-'));
  const recordingPath = path.join(root, 'session.cast');
  const channel = mockChannel();
  const session = new InteractiveSession({
    shell(_options: unknown, callback: (error: undefined, stream: ReturnType<typeof mockChannel>) => void) {
      callback(undefined, channel);
    }
  } as any, { recordFilePath: recordingPath });

  try {
    await session.start();
    channel.emit('data', Buffer.from('hello\n'));
    const recording = (session as any).recordStream as fs.WriteStream;
    const completed = new Promise<void>((resolve, reject) => {
      recording.once('finish', resolve);
      recording.once('error', reject);
    });
    channel.emit('close');
    await completed;

    const lines = fs.readFileSync(recordingPath, 'utf8').trim().split('\n');
    assert.strictEqual(JSON.parse(lines[0]).version, 2);
    assert.deepStrictEqual(JSON.parse(lines[1]).slice(1), ['o', 'hello\n']);
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(recordingPath).mode & 0o777, 0o600);
    assert.strictEqual(channel.listenerCount('data'), 0);
    assert.strictEqual(channel.stderr.listenerCount('data'), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('InteractiveSession: recording keeps UTF-8 characters split across chunks', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sshx-session-recording-utf8-'));
  const recordingPath = path.join(root, 'session.cast');
  const channel = mockChannel();
  const session = new InteractiveSession({
    shell(_options: unknown, callback: (error: undefined, stream: ReturnType<typeof mockChannel>) => void) {
      callback(undefined, channel);
    }
  } as any, { recordFilePath: recordingPath });

  try {
    await session.start();
    const text = Buffer.from('你好');
    const emoji = Buffer.from('🔑');
    channel.emit('data', text.subarray(0, 4));
    channel.stderr.emit('data', emoji.subarray(0, 2));
    channel.emit('data', text.subarray(4));
    channel.stderr.emit('data', emoji.subarray(2));
    const recording = (session as any).recordStream as fs.WriteStream;
    const completed = new Promise<void>((resolve, reject) => {
      recording.once('finish', resolve);
      recording.once('error', reject);
    });
    channel.emit('close');
    await completed;

    const [header, ...lines] = fs.readFileSync(recordingPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepStrictEqual(Object.keys(header.env), ['TERM']);
    assert.deepStrictEqual(lines.map(event => event[2]), ['你', '好', '🔑']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('InteractiveSession: recording backpressure pauses and resumes SSH output', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sshx-session-recording-backpressure-'));
  const channel = mockChannel();
  const paused: boolean[] = [];
  channel.pause = () => { paused.push(true); };
  channel.resume = () => { paused.push(false); };
  const session = new InteractiveSession({
    shell(_options: unknown, callback: (error: undefined, stream: ReturnType<typeof mockChannel>) => void) {
      callback(undefined, channel);
    }
  } as any, { recordFilePath: path.join(root, 'session.cast') });

  try {
    await session.start();
    const recording = (session as any).recordStream as fs.WriteStream;
    recording.write = () => false;
    channel.emit('data', Buffer.from('output'));
    assert.deepStrictEqual(paused, [true]);
    recording.emit('drain');
    assert.deepStrictEqual(paused, [true, false]);
    channel.emit('close');
  } finally {
    channel.emit('close');
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('InteractiveSession: channel errors close the session before reporting failure', async () => {
  const channel = mockChannel();
  const session = new InteractiveSession({
    shell(_options: unknown, callback: (error: undefined, stream: ReturnType<typeof mockChannel>) => void) {
      callback(undefined, channel);
    }
  } as any);
  const closed = new Promise<void>(resolve => session.once('close', resolve));
  let error: Error | undefined;
  session.on('error', (value: Error) => { error = value; });

  await session.start();
  channel.emit('error', new Error('transport lost'));
  await closed;
  assert.strictEqual(session.running(), false);
  assert.strictEqual(error?.message, 'transport lost');
});

test('InteractiveSession: shell startup failure does not create a recording file', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sshx-session-recording-'));
  const recordingPath = path.join(temporary, 'nested', 'session.cast');
  const session = new InteractiveSession({
    shell(_options: unknown, callback: (error: Error) => void) {
      callback(new Error('shell unavailable'));
    }
  } as any, { recordFilePath: recordingPath });

  try {
    await assert.rejects(session.start(), /shell unavailable/);
    assert.strictEqual(fs.existsSync(path.dirname(recordingPath)), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('InteractiveSession: local attachment is idempotent and restores terminal state', async (context) => {
  const rawModes: boolean[] = [];
  const pauses = context.mock.fn();
  const input = Object.assign(new EventEmitter(), {
    isTTY: true,
    isRaw: false,
    isPaused: () => true,
    setRawMode: (raw: boolean) => rawModes.push(raw),
    pause: pauses,
    resume() {}
  });
  const write = context.mock.fn((_chunk: Buffer) => true);
  const output = Object.assign(new EventEmitter(), { isTTY: true, columns: 100, rows: 30, write });
  context.mock.getter(process, 'stdin', () => input as unknown as typeof process.stdin);
  context.mock.getter(process, 'stdout', () => output as unknown as typeof process.stdout);
  const channel = mockChannel();
  const session = new InteractiveSession({
    shell(_options: unknown, callback: (error: undefined, stream: ReturnType<typeof mockChannel>) => void) {
      callback(undefined, channel);
    }
  } as any);

  await session.start();
  session.attachToLocalProcess();
  session.attachToLocalProcess();
  assert.strictEqual(input.listenerCount('data'), 1);
  assert.strictEqual(session.listenerCount('data'), 1);
  session.emit('data', Buffer.from('hello'));
  assert.strictEqual(write.mock.callCount(), 1);

  channel.emit('close');
  assert.strictEqual(input.listenerCount('data'), 0);
  assert.strictEqual(session.listenerCount('data'), 0);
  assert.deepStrictEqual(rawModes, [true, false]);
  assert.strictEqual(pauses.mock.callCount(), 1);
});

test('MetricsCollector: parses raw shell metrics output into structured ServerMetrics', () => {
  const rawOutput = `
USER=root
HOST=prod-srv-01
OS=Ubuntu 24.04 LTS
UP=12d 4h 15m
IP=10.0.0.5
LOAD=1.45 0.98 0.85
CPUM=AMD EPYC 7763 64-Core Processor
CPUC=8
CPUSTAT=cpu 10000 200 5000 80000 100 50 20 0 0 0
MT=16384
MU=8192
DISKS=/|524288000|209715200|314572800;
NETS=eth0|100000000|50000000|10.0.0.5|up;
GPUS=0, NVIDIA A100-SXM4-40GB, 10240, 40960, 45, 52;
`.trim();

  // Create collector with dummy client
  const collector = new MetricsCollector({} as any);
  const metrics = collector.parseOutput(rawOutput);

  assert.strictEqual(metrics.user, 'root');
  assert.strictEqual(metrics.hostname, 'prod-srv-01');
  assert.strictEqual(metrics.os, 'Ubuntu 24.04 LTS');
  assert.strictEqual(metrics.ip, '10.0.0.5');
  assert.strictEqual(metrics.cpu.cores, 8);
  assert.strictEqual(metrics.cpu.model, 'AMD EPYC 7763 64-Core Processor');
  assert.strictEqual(metrics.memory.totalMB, 16384);
  assert.strictEqual(metrics.memory.usedMB, 8192);
  assert.strictEqual(metrics.memory.percent, 50);
  assert.strictEqual(metrics.disk.percent, 40);
  assert.strictEqual(metrics.disk.used, '200G');
  assert.strictEqual(metrics.disk.total, '500G');
  assert.strictEqual(metrics.disks?.length, 1);
  assert.strictEqual(metrics.networks?.[0].ip, '10.0.0.5');

  assert.ok(metrics.gpu, 'GPU metrics should be present');
  assert.strictEqual(metrics.gpu?.model, 'NVIDIA A100-SXM4-40GB');
  assert.strictEqual(metrics.gpu?.vramUsedMB, 10240);
  assert.strictEqual(metrics.gpu?.vramTotalMB, 40960);
  assert.strictEqual(metrics.gpu?.vramPercent, 25);
  assert.strictEqual(metrics.gpu?.utilPercent, 45);
  assert.strictEqual(metrics.gpu?.temp, 52);
});

test('SidebarRenderer: formats sidebar lines within width constraints', () => {
  const dummyMetrics: ServerMetrics = {
    user: 'ubuntu',
    hostname: 'cloud-vm',
    ip: '192.168.1.100',
    os: 'Debian 12',
    uptime: '5 days',
    cpu: {
      model: 'Intel Xeon Platinum',
      cores: 4,
      load: '0.20 0.15 0.10',
      usagePercent: 24.5
    },
    memory: {
      totalMB: 8192,
      usedMB: 2048,
      percent: 25.0
    },
    disk: {
      mount: '/',
      total: '100G',
      used: '35G',
      avail: '65G',
      percent: 35
    },
    network: {
      rxBytesSec: 1024 * 512,
      txBytesSec: 1024 * 128,
      rxFormatted: '512.0 KB/s',
      txFormatted: '128.0 KB/s'
    },
    gpu: {
      model: 'RTX 4090',
      temp: 48,
      utilPercent: 32,
      vramUsedMB: 4096,
      vramTotalMB: 24576,
      vramPercent: 17
    },
    updatedAt: Date.now()
  };

  const width = 34;
  const height = 30;
  const lines = SidebarRenderer.render(dummyMetrics, width, height, defaultSidebarTheme);

  assert.strictEqual(lines.length, height);
  for (const line of lines) {
    // Strip ANSI codes and verify display width is exactly width
    const clean = line.replace(/\x1b\[[0-9;]*m/g, '');
    const w = stringWidth(clean);
    assert.strictEqual(w, width, `Line display width (${w}) must be exactly width (${width}): "${clean}"`);
  }
});

function multiSample(t: number): string {
  return `
USER=root
HOST=gpu-node
OS=Ubuntu 22.04.4 LTS
UP=37 days
IP=10.0.0.62
LOAD=12.10 11.80 11.42
CPUM=Intel(R) Xeon(R) Gold 6462C
CPUC=128
CPUSTAT=cpu ${1000 * t} 0 ${300 * t} ${8000 * t} 0 0 0 0 0 0
CPUSOCK=1|64|${5000 * t}|${3900 * t};0|64|${4000 * t}|${3600 * t};
MT=1031544
MU=412000
DISKS=/data|2061430784|1789000000|167000000;/|514937676|241999324|246721800;/mnt/scratch|3750000000|500000000|3060000000;
NETS=eth0|${1000 * t}|${3000 * t}|10.0.0.62|up;wlan0|0|0||down;eth1|${500 * t}|${200 * t}||up;ib0|${9000 * t}|${8000 * t}|172.16.0.62|unknown;
GPUS=0, NVIDIA L40S, 38123, 46068, 98, 64;1, NVIDIA L40S, 0, 46068, 0, 31;2, NVIDIA GeForce RTX 4090, 22850, 24564, 77, 58;3, NVIDIA GeForce RTX 4090, 1200, 24564, 3, 35;
`.trim();
}

test('MetricsCollector: parses multiple CPU sockets, disks, NICs and GPUs', () => {
  const collector = new MetricsCollector({} as any);
  collector.parseOutput(multiSample(1));
  // Pretend a full second passed so rates come out in bytes/sec
  (collector as any).lastSampleTime -= 1000;
  const metrics = collector.parseOutput(multiSample(2));

  assert.deepStrictEqual(metrics.cpu.sockets?.map(s => s.id), [0, 1]);
  assert.strictEqual(metrics.cpu.sockets?.[0].threads, 64);
  assert.strictEqual(metrics.cpu.sockets?.[0].usagePercent, 10);
  assert.strictEqual(metrics.cpu.sockets?.[1].usagePercent, 22);

  // Root first, then larger volumes; Use% rounded up like df
  assert.deepStrictEqual(metrics.disks?.map(d => d.mount), ['/', '/mnt/scratch', '/data']);
  assert.strictEqual(metrics.disk.mount, '/');
  assert.strictEqual(metrics.disks?.[2].percent, 92);
  assert.strictEqual(metrics.disks?.[2].total, '1.9T');

  // Down interface without an address is dropped; addressed interfaces come first
  assert.deepStrictEqual(metrics.networks?.map(n => n.name), ['eth0', 'ib0', 'eth1']);
  const eth0 = metrics.networks?.find(n => n.name === 'eth0');
  assert.ok(eth0 && Math.abs(eth0.rxBytesSec - 1000) <= 2, `eth0 rx rate ${eth0?.rxBytesSec}`);
  assert.ok(Math.abs(metrics.network.rxBytesSec - 10500) <= 10, `total rx rate ${metrics.network.rxBytesSec}`);

  assert.strictEqual(metrics.gpus?.length, 4);
  assert.deepStrictEqual(metrics.gpus?.map(g => g.index), [0, 1, 2, 3]);
  assert.strictEqual(metrics.gpus?.[2].model, 'NVIDIA GeForce RTX 4090');
  assert.strictEqual(metrics.gpus?.[1].vramPercent, 0);
  assert.strictEqual(metrics.gpu?.model, 'NVIDIA L40S');
});

test('SidebarRenderer: lays out multiple resources at any terminal height', () => {
  const collector = new MetricsCollector({} as any);
  collector.parseOutput(multiSample(1));
  const metrics = collector.parseOutput(multiSample(2));
  const width = 34;

  for (const height of [12, 18, 24, 30, 40, 60]) {
    const lines = SidebarRenderer.render(metrics, width, height, defaultSidebarTheme);
    assert.strictEqual(lines.length, height);
    for (const line of lines) {
      const w = stringWidth(line);
      assert.strictEqual(w, width, `height ${height}: line width ${w} != ${width}: "${line.replace(/\x1b\[[0-9;]*m/g, '')}"`);
    }
  }

  const tall = SidebarRenderer.render(metrics, width, 60).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
  for (const expected of ['2× Intel Xeon Gold 6462C', 'CPU0', 'CPU1', '/mnt/scratch', '/data', 'eth1', '172.16.0.62', '#3 RTX 4090', 'VRAM']) {
    assert.ok(tall.includes(expected), `tall sidebar should show "${expected}"`);
  }
  assert.ok(!tall.includes('more'), 'nothing should be hidden when there is room');

  // Standard 24-row terminal: everything compact, but every GPU still listed
  const short = SidebarRenderer.render(metrics, width, 24).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
  for (const expected of ['#0', '#1', '#2', '#3', 'eth1', '/data']) {
    assert.ok(short.includes(expected), `24-row sidebar should show "${expected}"`);
  }

  const tiny = SidebarRenderer.render(metrics, width, 18).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
  assert.ok(tiny.includes('+3 more'), 'tiny sidebar should summarise hidden GPUs');
});

test('padClip: clipping colored text keeps escape sequences whole and width exact', () => {
  const colored = '\x1b[38;5;253mabc\x1b[0mdef';
  const clipped = padClip(colored, 3);
  assert.strictEqual(stringWidth(clipped), 3);
  assert.ok(clipped.includes('\x1b[0m'), 'reset sequence must survive truncation');
  assert.strictEqual(clipped.replace(/\x1b\[[0-9;]*m/g, ''), 'ab…');

  // Dropping a double-width char must not leave the cell short
  assert.strictEqual(stringWidth(padClip('中文字', 5)), 5);
  assert.strictEqual(padClip('中文字', 5), '中文…');
});

test('MetricsCollector: backs off after consecutive failures and parses macOS CPUPCT', async (context) => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  let shouldFail = true;
  let calls = 0;
  let capturedCommand = '';
  const collector = new MetricsCollector(Object.assign(new EventEmitter(), {
    exec(command: string, _options: unknown, callback: (err?: Error, ch?: ReturnType<typeof mockChannel>) => void) {
      calls++;
      capturedCommand = command;
      if (shouldFail) {
        callback(new Error('unsupported'));
        return;
      }
      const ch = mockChannel();
      callback(undefined, ch);
      ch.emit('data', Buffer.from('HOST=mac-mini\nOS=macOS\nCPUSTAT=\nCPUPCT=37.4\nMT=16384\nMU=8192\n'));
      ch.emit('exit', 0);
      ch.emit('close');
    }
  }) as any, 25);

  try {
    collector.start();
    assert.ok(capturedCommand.startsWith("sh -c '"));
    await flushPoll();
    assert.strictEqual(calls, 1);

    // 1st failure retries on next tick
    context.mock.timers.tick(25);
    await flushPoll();
    assert.strictEqual(calls, 2);

    // 2nd failure skips 1 tick
    context.mock.timers.tick(25);
    await flushPoll();
    assert.strictEqual(calls, 2);

    shouldFail = false;
    context.mock.timers.tick(25);
    await flushPoll();
    assert.strictEqual(calls, 3);
    assert.strictEqual(collector.getLatest()?.cpu.usagePercent, 37.4);
    assert.strictEqual(collector.getLatest()?.memory.percent, 50);

    // After success, backoff resets
    context.mock.timers.tick(25);
    await flushPoll();
    assert.strictEqual(calls, 4);
  } finally {
    collector.stop();
  }
});
