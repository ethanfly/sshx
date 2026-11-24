import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Duplex, PassThrough } from 'node:stream';
import { text } from 'node:stream/consumers';
import { fileURLToPath } from 'node:url';
import type { Client } from 'ssh2';
import ssh2 from 'ssh2';
import { SocksClient } from 'socks';
import {
  ConfigManager,
  KnownHostsManager,
  SSHConnection,
  Tunnel,
  TunnelManager,
  parsePortForwardString
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

test('Tunnel: parses remote bind and local target in both -R forms', () => {
  const { id: _defaultID, ...defaultBind } = parsePortForwardString('9000:localhost:3000', 'remote');
  const { id: _explicitID, ...explicitBind } = parsePortForwardString('192.0.2.10:9000:localhost:3000', 'remote');
  assert.deepEqual(defaultBind, {
    type: 'remote',
    remoteHost: '127.0.0.1',
    remotePort: 9000,
    localHost: 'localhost',
    localPort: 3000
  });
  assert.deepEqual(explicitBind, { ...defaultBind, remoteHost: '192.0.2.10' });
});

test('Tunnel: rejects invalid forwarding ports and malformed dynamic specifications', () => {
  for (const spec of ['abc', '0', '65536', '1080junk', '127.0.0.1:', '127.0.0.1:1080:extra']) {
    assert.throws(() => parsePortForwardString(spec, 'dynamic'), /Invalid port forwarding specification/, spec);
  }
  for (const spec of ['nope:localhost:80', '8080:localhost:0', '8080:localhost:65536', '8080:localhost:80junk', ':8080:localhost:80']) {
    assert.throws(() => parsePortForwardString(spec, 'local'), /Invalid port forwarding specification/, spec);
  }
});

test('Tunnel: remote forwarding removes its handler on stop and restart', async () => {
  const client = Object.assign(new EventEmitter(), {
    forwardIn(_host: string, _port: number, callback: () => void) { callback(); },
    unforwardIn(_host: string, _port: number, callback: () => void) { callback(); }
  });
  const manager = new TunnelManager(client as unknown as Client);
  const tunnel = await manager.addTunnel(parsePortForwardString('12433:localhost:12434', 'remote'));

  for (let attempt = 0; attempt < 3; attempt++) {
    await tunnel.start();
    assert.equal(client.listenerCount('tcp connection'), 1);
    await tunnel.stop();
    assert.equal(client.listenerCount('tcp connection'), 0);
  }
  assert.equal(tunnel.getStats().activeConnections, 0);
});

test('Tunnel: a standalone tunnel reports start failures through its promise', async () => {
  const client = Object.assign(new EventEmitter(), {
    forwardIn(_host: string, _port: number, callback: (error: unknown) => void) { callback('administratively prohibited'); }
  });
  const tunnel = new Tunnel(client as unknown as Client, parsePortForwardString('12435:localhost:12436', 'remote'));

  await assert.rejects(tunnel.start(), { message: 'administratively prohibited' });
  assert.equal(tunnel.getStats().status, 'error');
  assert.equal(tunnel.getStats().error, 'administratively prohibited');
});

test('Tunnel: remote forwarding stops locally after SSH has disconnected', async () => {
  const client = Object.assign(new EventEmitter(), {
    forwardIn(_host: string, _port: number, callback: () => void) { callback(); },
    unforwardIn() { throw new Error('Not connected'); }
  });
  const tunnel = await new TunnelManager(client as unknown as Client).addTunnel(parsePortForwardString('12443:localhost:12444', 'remote'));
  await tunnel.start();
  await tunnel.stop();
  assert.equal(tunnel.getStats().status, 'stopped');
  assert.equal(client.listenerCount('tcp connection'), 0);
});

test('Tunnel: active local connection is counted once after error and close', async () => {
  const forwarded: Array<(error: Error) => void> = [];
  const client = Object.assign(new EventEmitter(), {
    forwardOut(_sourceHost: string, _sourcePort: number, _targetHost: string, _targetPort: number,
      callback: (error: Error) => void) { forwarded.push(callback); }
  });
  const manager = new TunnelManager(client as unknown as Client);
  const tunnel = await manager.addTunnel({
    id: 'count-connections', type: 'local', localPort: 0,
    remoteHost: '127.0.0.1', remotePort: 22
  });
  await tunnel.start();
  const server = (tunnel as unknown as { server: net.Server }).server;
  const port = (server.address() as net.AddressInfo).port;
  const acceptedSocket = new Promise<net.Socket>(resolve => server.once('connection', resolve));
  const bothConnected = new Promise<void>(resolve => {
    tunnel.on('connection', (counts: { active: number }) => {
      if (counts.active === 2) resolve();
    });
  });
  const socket = net.connect(port, '127.0.0.1');
  const otherSocket = net.connect(port, '127.0.0.1');
  try {
    await Promise.all([once(socket, 'connect'), once(otherSocket, 'connect')]);
    await bothConnected;
    assert.equal(tunnel.getStats().activeConnections, 2);
    assert.equal(forwarded.length, 2);
    const first = await acceptedSocket;
    first.emit('error', new Error('connection reset'));
    forwarded[0](new Error('forward refused'));
    await once(socket, 'close');
    assert.equal(tunnel.getStats().activeConnections, 1);
    assert.equal(tunnel.getStats().totalConnections, 2);
  } finally {
    socket.destroy();
    otherSocket.destroy();
    await tunnel.stop();
  }
});

test('Tunnel: late socket close after stop cannot decrement new connection count', async () => {
  const client = Object.assign(new EventEmitter(), {
    forwardOut() {}
  });
  const tunnel = await new TunnelManager(client as unknown as Client).addTunnel({
    id: 'late-close', type: 'local', localPort: 0,
    remoteHost: '127.0.0.1', remotePort: 22
  });
  await tunnel.start();
  const server = (tunnel as unknown as { server: net.Server }).server;
  const accepted = new Promise<net.Socket>(resolve => server.once('connection', resolve));
  const socket = net.connect((server.address() as net.AddressInfo).port, '127.0.0.1');
  const first = await accepted;
  await once(socket, 'connect');
  await tunnel.stop();
  assert.equal(tunnel.getStats().activeConnections, 0);
  await tunnel.start();
  const second = new net.Socket();
  const internals = tunnel as unknown as { handleSocketConnection(socket: net.Socket): void };
  internals.handleSocketConnection(second);
  first.emit('close');
  assert.equal(tunnel.getStats().activeConnections, 1);
  second.destroy();
  socket.destroy();
  await tunnel.stop();
});

test('Tunnel: local forwarding closes its socket when the SSH channel fails', async () => {
  let acceptChannel!: (stream: PassThrough) => void;
  const channelReady = new Promise<PassThrough>(resolve => { acceptChannel = resolve; });
  const channel = new PassThrough();
  const client = Object.assign(new EventEmitter(), {
    forwardOut(_sourceHost: string, _sourcePort: number, _targetHost: string, _targetPort: number,
      callback: (error: Error | undefined, stream: PassThrough) => void) {
      callback(undefined, channel);
      acceptChannel(channel);
    }
  });
  const tunnel = await new TunnelManager(client as unknown as Client).addTunnel({
    id: 'failed-channel', type: 'local', localPort: 0,
    remoteHost: '127.0.0.1', remotePort: 22
  });
  await tunnel.start();
  const server = (tunnel as unknown as { server: net.Server }).server;
  const socket = net.connect((server.address() as net.AddressInfo).port, '127.0.0.1');
  try {
    await once(socket, 'connect');
    await channelReady;
    const closed = new Promise<void>(resolve => socket.once('close', () => resolve()));
    channel.emit('error', new Error('SSH channel closed'));
    await closed;
    assert.equal(tunnel.getStats().activeConnections, 0);
  } finally {
    socket.destroy();
    await tunnel.stop();
  }
});

test('Tunnel: SOCKS5 accepts fragmented frames but rejects missing no-auth method', { timeout: 8000 }, async () => {
  const conn = new SSHConnection({
    profile: {
      id: 'mock_socks_frames', name: 'mock', host: '127.0.0.1', port: sshPort,
      username: 'testuser', authType: 'password', password: 'testpass'
    },
    configManager,
    knownHostsManager: testKnownHosts
  });
  await conn.connect();
  const manager = new TunnelManager(conn.getRawClient());
  const tunnel = await manager.addTunnel({ id: 'frames', type: 'dynamic', localPort: 0 });
  await tunnel.start();
  const server = (tunnel as unknown as { server: net.Server }).server;
  const port = (server.address() as net.AddressInfo).port;
  try {
    const unsupported = net.connect(port, '127.0.0.1');
    await once(unsupported, 'connect');
    const unsupportedResponse = once(unsupported, 'data');
    unsupported.write(Buffer.from([5, 1, 2]));
    const [rejection] = await unsupportedResponse;
    assert.deepEqual(rejection, Buffer.from([5, 0xff]));
    unsupported.destroy();

    const socket = net.connect(port, '127.0.0.1');
    await once(socket, 'connect');
    const greeting = once(socket, 'data');
    socket.write(Buffer.from([5]));
    await new Promise(resolve => setTimeout(resolve, 10));
    socket.write(Buffer.from([1, 0]));
    const [accepted] = await greeting;
    assert.deepEqual(accepted, Buffer.from([5, 0]));

    const response = once(socket, 'data');
    const request = Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, targetHttpPort >> 8, targetHttpPort & 0xff]);
    socket.write(request.subarray(0, 5));
    await new Promise(resolve => setTimeout(resolve, 10));
    socket.write(request.subarray(5));
    const [reply] = await response;
    assert.equal(reply.subarray(0, 2).toString('hex'), '0500');

    const body = text(socket);
    socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
    assert.match(await body, /TUNNEL_SUCCESS/);
    await once(socket, 'close');
    const remaining = tunnel.getStats().activeConnections;
    assert.ok(remaining <= 1);
    socket.destroy();
  } finally {
    await tunnel.stop();
    assert.equal(tunnel.getStats().activeConnections, 0);
    conn.disconnect();
  }
});

test('Tunnel: SOCKS5 handles coalesced greeting, request and application data', { timeout: 8000 }, async () => {
  const connection = new SSHConnection({
    profile: {
      id: 'mock_socks_coalesced', name: 'mock', host: '127.0.0.1', port: sshPort,
      username: 'testuser', authType: 'password', password: 'testpass'
    },
    configManager,
    knownHostsManager: testKnownHosts
  });
  await connection.connect();
  const tunnel = await new TunnelManager(connection.getRawClient()).addTunnel({ id: 'coalesced', type: 'dynamic', localPort: 0 });
  await tunnel.start();
  const server = (tunnel as unknown as { server: net.Server }).server;
  const socket = net.connect((server.address() as net.AddressInfo).port, '127.0.0.1');
  try {
    await once(socket, 'connect');
    const response = text(socket);
    const destination = Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, targetHttpPort >> 8, targetHttpPort & 0xff]);
    socket.write(Buffer.concat([
      Buffer.from([5, 1, 0]), destination,
      Buffer.from('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n')
    ]));
    const result = await response;
    assert.equal(result.charCodeAt(0), 5);
    assert.equal(result.charCodeAt(1), 0);
    assert.equal(result.charCodeAt(2), 5);
    assert.equal(result.charCodeAt(3), 0);
    assert.match(result, /TUNNEL_SUCCESS/);
  } finally {
    socket.destroy();
    await tunnel.stop();
    connection.disconnect();
  }
});

test('Tunnel: Remote Port Forwarding (-R) connects to the local target', { timeout: 5000 }, async (context) => {
  const bindPort = targetHttpPort === 9000 ? 9001 : 9000;
  const bindHost = '127.0.0.1';
  const client = Object.assign(new EventEmitter(), {
    forwardIn(host: string, port: number, callback: () => void) {
      assert.equal(host, bindHost);
      assert.equal(port, bindPort);
      callback();
    },
    unforwardIn(host: string, port: number, callback: () => void) {
      assert.equal(host, bindHost);
      assert.equal(port, bindPort);
      callback();
    }
  });

  const manager = new TunnelManager(client as unknown as Client);
  const config = parsePortForwardString(`${bindPort}:${bindHost}:${targetHttpPort}`, 'remote');
  const tunnel = await manager.addTunnel(config);
  await tunnel.start();
  context.after(() => tunnel.stop());

  const request = new PassThrough();
  const response = new PassThrough();
  const channel = Duplex.from({ readable: request, writable: response });
  context.after(() => { channel.destroy(); });

  client.emit('tcp connection', { destIP: bindHost, destPort: bindPort }, () => channel);
  const pending = text(response);
  request.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
  assert.match(await pending, /TUNNEL_SUCCESS/);
});

test('Tunnel CLI releases its listener on SSH connection close', { timeout: 8000 }, async (context) => {
  const sshServer = new ssh2.Server({ hostKeys: [mockServer.hostKeyPem] });
  const connectionArrival = once(sshServer, 'connection');
  sshServer.on('connection', (connection) => {
    connection.on('authentication', (auth) => {
      if (auth.method === 'password' && auth.username === mockServer.username && auth.password === mockServer.password) {
        auth.accept();
      } else {
        auth.reject(['password']);
      }
    });
  });
  const sshListening = once(sshServer, 'listening');
  sshServer.listen(0, '127.0.0.1');
  context.after(() => { sshServer.close(); });
  await sshListening;

  const portProbe = net.createServer();
  const probeListening = once(portProbe, 'listening');
  portProbe.listen(0, '127.0.0.1');
  await probeListening;
  const localPort = (portProbe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => { portProbe.close(() => resolve()); });

  const sshListenPort = (sshServer.address() as net.AddressInfo).port;
  const cliPath = fileURLToPath(new URL('../bin/sshx.js', import.meta.url));
  const cli = spawn(process.execPath, [
    cliPath, 'tunnel', `${mockServer.username}@127.0.0.1`, '-p', String(sshListenPort),
    '-L', `${localPort}:127.0.0.1:${targetHttpPort}`
  ], {
    env: {
      ...process.env,
      HOME: tempConfigDir,
      USERPROFILE: tempConfigDir,
      SSHX_CONFIG_DIR: tempConfigDir,
      SSH_PASSWORD: mockServer.password
    },
    signal: context.signal
  });
  const cliClosed = once(cli, 'close');
  const diagnostics = text(cli.stderr);
  const ready = (async () => {
    let stdout = '';
    for await (const chunk of cli.stdout) {
      stdout += chunk.toString();
      if (stdout.includes('Tunnels active')) return true;
    }
    return false;
  })();
  const [connection] = await connectionArrival;
  try {
    assert.equal(await ready, true);
  } finally {
    connection.end();
  }

  const [exitCode, signal] = await cliClosed;
  assert.equal(signal, null);
  assert.equal(exitCode, 1);
  assert.match(await diagnostics, /SSH connection closed unexpectedly/);

  const rebind = net.createServer();
  const listening = once(rebind, 'listening');
  rebind.listen(localPort, '127.0.0.1');
  context.after(() => { rebind.close(); });
  await listening;
});
