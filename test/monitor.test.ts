import test from 'node:test';
import assert from 'node:assert';
import { MetricsCollector } from '../dist/core/metrics.js';
import { SidebarRenderer, defaultSidebarTheme } from '../dist/tui/sidebar.js';
import { stringWidth } from '../dist/tui/screen.js';

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
DISK=500G 200G 300G 40%
NET=100000000 50000000
GPU=NVIDIA A100-SXM4-40GB, 10240, 40960, 45, 52
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
