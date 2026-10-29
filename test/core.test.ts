import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  ConfigManager,
  KnownHostsManager,
  KeyManager,
  SSHConnection,
  execCommand,
  SFTPClient,
  TunnelManager,
  parsePortForwardString,
  resolvePortablePath,
  toPortablePath
} from '../dist/index.js';
import { stringWidth, padClip } from '../dist/tui/screen.js';
import { TuiApp } from '../dist/tui/app.js';
import { MockSSHServer } from './mock-server.ts';

let mockServer: MockSSHServer;
let serverPort: number;
let tempConfigDir: string;
let configManager: ConfigManager;
let testKnownHosts: KnownHostsManager;

before(async () => {
  mockServer = new MockSSHServer({ port: 0 }); // Pick random available port
  serverPort = await mockServer.start();

  tempConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshx-config-test-'));
  configManager = new ConfigManager(tempConfigDir);
  testKnownHosts = new KnownHostsManager(path.join(tempConfigDir, 'known_hosts'));
});

after(async () => {
  await mockServer.stop();
  fs.rmSync(tempConfigDir, { recursive: true, force: true });
});

test('ConfigManager: adds, retrieves, updates and deletes host profile', () => {
  const host = configManager.addHost({
    name: 'test-server',
    host: '127.0.0.1',
    port: serverPort,
    username: 'testuser',
    authType: 'password',
    password: 'testpass',
    tags: ['dev', 'local']
  });

  assert.ok(host.id);
  assert.equal(host.name, 'test-server');

  const fetched = configManager.getHost('test-server');
  assert.ok(fetched);
  assert.equal(fetched.username, 'testuser');

  const updated = configManager.updateHost('test-server', { port: 2222 });
  assert.ok(updated);
  assert.equal(updated.port, 2222);

  const deleted = configManager.deleteHost('test-server');
  assert.ok(deleted);
  assert.equal(configManager.getHost('test-server'), undefined);
});

test('ConfigManager: portable path resolution and export/import', () => {
  // Test portable path utilities
  const home = os.homedir();
  assert.equal(resolvePortablePath('~'), home);
  assert.equal(resolvePortablePath('~/test/key'), path.join(home, 'test', 'key'));

  process.env.TEST_SSH_DIR = '/custom/ssh';
  assert.equal(resolvePortablePath('$TEST_SSH_DIR/id_rsa'), path.normalize('/custom/ssh/id_rsa'));
  assert.equal(resolvePortablePath('${TEST_SSH_DIR}/id_rsa'), path.normalize('/custom/ssh/id_rsa'));
  assert.equal(resolvePortablePath('%TEST_SSH_DIR%/id_rsa'), path.normalize('/custom/ssh/id_rsa'));
  delete process.env.TEST_SSH_DIR;

  assert.equal(toPortablePath(path.join(home, '.ssh', 'id_ed25519')), '~/.ssh/id_ed25519');

  // Test host export and import
  configManager.addHost({
    name: 'export-test-1',
    host: '10.0.0.1',
    port: 22,
    username: 'user1',
    privateKeyPath: path.join(home, '.ssh', 'id_rsa'),
    tags: ['export', 'shared']
  });

  const exportFile = path.join(tempConfigDir, 'exported_hosts.json');
  const jsonStr = configManager.exportHosts(exportFile);
  assert.ok(fs.existsSync(exportFile));
  assert.ok(jsonStr.includes('~/.ssh/id_rsa'));

  // Test import into a fresh ConfigManager
  const freshConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshx-import-test-'));
  const freshMgr = new ConfigManager(freshConfigDir);
  const importRes = freshMgr.importHosts(exportFile);
  assert.equal(importRes.imported, 1);
  assert.equal(importRes.total, 1);

  const importedHost = freshMgr.getHost('export-test-1');
  assert.ok(importedHost);
  assert.equal(importedHost.host, '10.0.0.1');
  assert.equal(importedHost.privateKeyPath, '~/.ssh/id_rsa');

  // Test OpenSSH config import with Include support
  const sshDir = path.join(tempConfigDir, '.ssh');
  const configD = path.join(sshDir, 'config.d');
  fs.mkdirSync(configD, { recursive: true });

  const mainConfig = path.join(sshDir, 'config');
  fs.writeFileSync(mainConfig, 'Include config.d/*\n');

  const subConfig = path.join(configD, 'hosts.conf');
  fs.writeFileSync(subConfig, `
Host server-alpha
    HostName 192.168.1.100
    User admin
    Port 2222
    IdentityFile ~/.ssh/id_ed25519
`);

  const importedSshHosts = freshMgr.importOpenSSHConfig(mainConfig);
  assert.equal(importedSshHosts.length, 1);
  assert.equal(importedSshHosts[0].name, 'server-alpha');
  assert.equal(importedSshHosts[0].host, '192.168.1.100');
  assert.equal(importedSshHosts[0].port, 2222);
  assert.equal(importedSshHosts[0].username, 'admin');

  fs.rmSync(freshConfigDir, { recursive: true, force: true });
});

test('KeyManager: generates valid Ed25519 and RSA keys and saves to disk', () => {
  const edKey = KeyManager.generateKeyPair({ type: 'ed25519', comment: 'test@ed' });
  assert.ok(edKey.publicKeyOpenSSH.startsWith('ssh-ed25519 '));
  assert.ok(edKey.fingerprintSha256.startsWith('SHA256:'));
  assert.ok(edKey.privateKeyPem.includes('BEGIN PRIVATE KEY'));

  const rsaKey = KeyManager.generateKeyPair({ type: 'rsa', bits: 2048, comment: 'test@rsa' });
  assert.ok(rsaKey.publicKeyOpenSSH.startsWith('ssh-rsa '));
  assert.ok(rsaKey.fingerprintSha256.startsWith('SHA256:'));

  const keyPath = path.join(tempConfigDir, 'id_test_ed25519');
  const files = KeyManager.saveKeyPairToDisk(keyPath, { type: 'ed25519', comment: 'saved@test' });
  assert.ok(fs.existsSync(files.privateKeyPath));
  assert.ok(fs.existsSync(files.publicKeyPath));
});

test('SSHConnection & execCommand: connects to mock server and executes commands', async () => {
  const conn = new SSHConnection({
    profile: {
      id: 'mock1',
      name: 'mock',
      host: '127.0.0.1',
      port: serverPort,
      username: 'testuser',
      authType: 'password',
      password: 'testpass'
    },
    configManager,
    knownHostsManager: testKnownHosts
  });

  await conn.connect();
  assert.ok(conn.connected());

  const result = await execCommand(conn.getRawClient(), 'echo hello');
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), 'hello');

  const unameRes = await execCommand(conn.getRawClient(), 'uname -a');
  assert.equal(unameRes.exitCode, 0);
  assert.ok(unameRes.stdout.includes('Linux'));

  conn.disconnect();
  assert.equal(conn.connected(), false);
});

test('SSHConnection: stored password authenticates even when authType is privateKey', async () => {
  const conn = new SSHConnection({
    profile: {
      id: 'mock-stored-pw',
      name: 'stored',
      host: '127.0.0.1',
      port: serverPort,
      username: 'testuser',
      authType: 'privateKey',
      password: 'testpass'
    },
    configManager,
    knownHostsManager: testKnownHosts
  });

  await conn.connect();
  assert.ok(conn.connected());
  const result = await execCommand(conn.getRawClient(), 'echo saved');
  assert.ok(result.stdout.includes('echo saved'));
  conn.disconnect();
});

test('SFTPClient: lists, writes, reads, and deletes remote files', async () => {
  const conn = new SSHConnection({
    profile: {
      id: 'mock_sftp',
      name: 'mock',
      host: '127.0.0.1',
      port: serverPort,
      username: 'testuser',
      authType: 'password',
      password: 'testpass'
    },
    configManager,
    knownHostsManager: testKnownHosts
  });

  await conn.connect();
  const sftp = new SFTPClient(conn.getRawClient());

  // Write file
  await sftp.writeFile('hello.txt', 'Hello SFTP World!');

  // Read file
  const content = await sftp.readFile('hello.txt');
  assert.equal(content, 'Hello SFTP World!');

  // List directory
  const files = await sftp.list('.');
  const found = files.find(f => f.filename === 'hello.txt');
  assert.ok(found);
  assert.equal(found.filename, 'hello.txt');

  // Remove file
  await sftp.rm('hello.txt');

  // Verify deletion
  const filesAfter = await sftp.list('.');
  assert.equal(filesAfter.find(f => f.filename === 'hello.txt'), undefined);

  conn.disconnect();
});

test('TunnelManager & Port Forwarding parser', () => {
  const localSpec = parsePortForwardString('8080:remote.server.internal:80', 'local');
  assert.equal(localSpec.localPort, 8080);
  assert.equal(localSpec.remoteHost, 'remote.server.internal');
  assert.equal(localSpec.remotePort, 80);

  const dynamicSpec = parsePortForwardString('1080', 'dynamic');
  assert.equal(dynamicSpec.localPort, 1080);
  assert.equal(dynamicSpec.type, 'dynamic');
});

test('TUI visual width: CJK fullwidth, ANSI escape sequences, padClip', () => {
  // English ASCII: 1 visual cell each
  assert.equal(stringWidth('hello'), 5);
  // Chinese CJK characters: 2 visual cells each
  assert.equal(stringWidth('66云美国'), 8);
  assert.equal(stringWidth('美国vps家宽'), 11);
  assert.equal(stringWidth('安邦服饰'), 8);

  // ANSI escape sequences must not count towards visual width
  assert.equal(stringWidth('\x1b[31m66云美国\x1b[0m'), 8);
  assert.equal(stringWidth('\x1b[1;32mtest\x1b[0m'), 4);

  // padClip ensures EXACT visual width
  const padded = padClip('66云美国', 12);
  assert.equal(stringWidth(padded), 12);
  assert.equal(padded, '66云美国    ');

  // padClip truncation with ellipsis
  const truncated = padClip('美国vps家宽生产服务器', 10);
  assert.equal(stringWidth(truncated), 10);
  assert.ok(truncated.endsWith('…'));
});

test('KnownHostsManager: wire format keys, extractKeyType, and accept-new verification', () => {
  const km = new KnownHostsManager(path.join(tempConfigDir, 'test_kh'));

  // Create mock raw wire format public key for ssh-ed25519
  // [uint32: 11][ssh-ed25519][uint32: 32][32 bytes key]
  const typeStr = 'ssh-ed25519';
  const typeBuf = Buffer.from(typeStr);
  const keyRaw = Buffer.alloc(4 + typeBuf.length + 4 + 32);
  keyRaw.writeUInt32BE(typeBuf.length, 0);
  typeBuf.copy(keyRaw, 4);
  keyRaw.writeUInt32BE(32, 4 + typeBuf.length);
  keyRaw.fill(0xab, 4 + typeBuf.length + 4);

  const extractedType = km.extractKeyType(keyRaw);
  assert.equal(extractedType, 'ssh-ed25519');

  // Verify accept-new adds new key
  const res1 = km.verifyHostKey('test.server.io', 22, extractedType, keyRaw, 'accept-new');
  assert.equal(res1.status, 'new');

  // Verify same key is trusted on next connection
  const res2 = km.verifyHostKey('test.server.io', 22, extractedType, keyRaw, 'accept-new');
  assert.equal(res2.status, 'trusted');

  // Verify changed key for same key type returns mismatch
  const changedKeyRaw = Buffer.from(keyRaw);
  changedKeyRaw[changedKeyRaw.length - 1] = 0xcd;
  const res3 = km.verifyHostKey('test.server.io', 22, extractedType, changedKeyRaw, 'accept-new');
  assert.equal(res3.status, 'mismatch');
  assert.ok(res3.message.includes('WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED'));
});

test('TuiApp: suspend and resume lifecycle restores stdin flowing state and raw mode', () => {
  const app = new TuiApp();
  // suspend sets inModal and rawMode false
  (app as any).suspend();
  assert.equal((app as any).inModal, true);

  // simulate session pausing stdin
  process.stdin.pause();
  assert.equal(process.stdin.isPaused(), true);

  // resume must clear inModal, resume stdin flowing mode, and restore rawMode
  (app as any).resume();
  assert.equal((app as any).inModal, false);
  assert.equal(process.stdin.isPaused(), false);

  // Restore paused state so node test runner does not wait for stdin
  process.stdin.pause();
});

