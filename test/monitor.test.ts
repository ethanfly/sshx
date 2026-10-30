import test from 'node:test';
import assert from 'node:assert';
import { MetricsCollector } from '../dist/core/metrics.js';
import { SidebarRenderer, defaultSidebarTheme } from '../dist/tui/sidebar.js';
import { padClip, stringWidth } from '../dist/tui/screen.js';

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
