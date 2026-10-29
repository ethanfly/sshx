import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SocksClient } from 'socks';
import {
  ConfigManager,
  KnownHostsManager,
  SSHConnection,
  TunnelManager
} from '../dist/index.js';
import { MockSSHServer } from './mock-server.ts';

let mockServer: MockSSHServer;
let sshPort: number;
let tempConfigDir: string;
let configManager: ConfigManager;
let testKnownHosts: KnownHostsManager;
let targetHttpServer: http.Server;
let targetHttpPort: number;

before(async () => {
  // Start target HTTP server to test forwarding through
  targetHttpServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('TUNNEL_SUCCESS');
  });

  await new Promise<void>((resolve) => {
    targetHttpServer.listen(0, '127.0.0.1', () => {
      targetHttpPort = (targetHttpServer.address() as net.AddressInfo).port;
      resolve();
    });
  });

  mockServer = new MockSSHServer({ port: 0 });
  sshPort = await mockServer.start();

  tempConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshx-tunnel-test-'));
  configManager = new ConfigManager(tempConfigDir);
  testKnownHosts = new KnownHostsManager(path.join(tempConfigDir, 'known_hosts'));
});

after(async () => {
  await mockServer.stop();
  await new Promise<void>((resolve) => targetHttpServer.close(() => resolve()));
  fs.rmSync(tempConfigDir, { recursive: true, force: true });
});

test('Tunnel: Dynamic Port Forwarding (SOCKS5 proxy)', async () => {
  const conn = new SSHConnection({
    profile: {
      id: 'mock_tunnel',
      name: 'mock',
      host: '127.0.0.1',
      port: sshPort,
      username: 'testuser',
      authType: 'password',
      password: 'testpass'
    },
    configManager,
    knownHostsManager: testKnownHosts
  });

  await conn.connect();

  const tm = new TunnelManager(conn.getRawClient());
  const socksTunnel = await tm.addTunnel({
    id: 'test_socks',
    type: 'dynamic',
    localPort: 0 // allocate dynamic port
  });

  // Assign random available port
  const tmpServer = net.createServer();
  const socksPort = await new Promise<number>((res) => {
    tmpServer.listen(0, '127.0.0.1', () => {
      const p = (tmpServer.address() as net.AddressInfo).port;
      tmpServer.close(() => res(p));
    });
  });
  socksTunnel.config.localPort = socksPort;

  await socksTunnel.start();
  assert.equal(socksTunnel.isRunning(), true);

  // Test SOCKS5 connection to target HTTP server through the proxy
  const { socket } = await SocksClient.createConnection({
    proxy: {
      host: '127.0.0.1',
      port: socksPort,
      type: 5
    },
    command: 'connect',
    destination: {
      host: '127.0.0.1',
      port: targetHttpPort
    }
  });

  const responseText = await new Promise<string>((resolve, reject) => {
    socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
    const chunks: Buffer[] = [];
    socket.on('data', (d) => chunks.push(d));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.on('error', reject);
  });

  assert.ok(responseText.includes('TUNNEL_SUCCESS'));

  await socksTunnel.stop();
  assert.equal(socksTunnel.isRunning(), false);
  conn.disconnect();
});

test('Tunnel: Local Port Forwarding (-L)', async () => {
  const conn = new SSHConnection({
    profile: {
      id: 'mock_local_tunnel',
      name: 'mock',
      host: '127.0.0.1',
      port: sshPort,
      username: 'testuser',
      authType: 'password',
      password: 'testpass'
    },
    configManager,
    knownHostsManager: testKnownHosts
  });

  await conn.connect();

  const tm = new TunnelManager(conn.getRawClient());
  const localTunnel = await tm.addTunnel({
    id: 'test_local',
    type: 'local',
    localPort: 0,
    remoteHost: '127.0.0.1',
    remotePort: targetHttpPort
  });

  // Assign random port
  const tmpServer = net.createServer();
  const localPort = await new Promise<number>((res) => {
    tmpServer.listen(0, '127.0.0.1', () => {
      const p = (tmpServer.address() as net.AddressInfo).port;
      tmpServer.close(() => res(p));
    });
  });
  localTunnel.config.localPort = localPort;

  await localTunnel.start();
  assert.equal(localTunnel.isRunning(), true);

  // Connect directly to localPort, should reach targetHttpServer
  const socket = net.connect(localPort, '127.0.0.1');
  const responseText = await new Promise<string>((resolve, reject) => {
    socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
    const chunks: Buffer[] = [];
    socket.on('data', (d) => chunks.push(d));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.on('error', reject);
  });

  assert.ok(responseText.includes('TUNNEL_SUCCESS'));

  await localTunnel.stop();
  assert.equal(localTunnel.isRunning(), false);
  conn.disconnect();
});
