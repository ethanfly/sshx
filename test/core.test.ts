import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import ssh2 from 'ssh2';
import {
  ConfigManager,
  KnownHostsManager,
  KeyManager,
  SSHConnection,
  execCommand,
  SFTPClient,
  TunnelManager,
  parsePortForwardString,
  parseOpenSSHConfig,
  parseOpenSSHConfigFile,
  calculateLevenshteinDistance,
  resolvePortablePath,
  toPortablePath
} from '../dist/index.js';
import { stringWidth, padClip } from '../dist/tui/screen.js';
import { TuiApp } from '../dist/tui/app.js';
import { computeTableLayout } from '../dist/tui/screens/hosts.js';
import { MockSSHServer } from './mock-server.ts';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

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

test('ConfigManager: changing a saved endpoint clears credentials and proxy settings', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sshx-update-endpoint-'));
  try {
    const manager = new ConfigManager(temporary);
    const original = manager.addHost({
      name: 'production',
      host: 'old.example.test',
      authType: 'privateKey',
      password: 'old password',
      privateKey: 'old key',
      privateKeyPath: '~/.ssh/old-key',
      passphrase: 'old passphrase',
      proxyJump: 'old-jump',
      proxyCommand: 'old proxy command'
    });

    const updated = manager.updateHost(original.id, { ...original, host: 'new.example.test' });

    assert.ok(updated);
    assert.equal(updated.id, original.id);
    assert.equal(updated.host, 'new.example.test');
    assert.equal(updated.authType, 'password');
    assert.equal(updated.password, undefined);
    assert.equal(updated.privateKey, undefined);
    assert.equal(updated.privateKeyPath, undefined);
    assert.equal(updated.passphrase, undefined);
    assert.equal(updated.proxyJump, undefined);
    assert.equal(updated.proxyCommand, undefined);

    const newPassword = manager.updateHost(original.id, {
      ...updated,
      host: 'password.example.test',
      password: 'replacement password',
      proxyJump: 'new-jump'
    });
    assert.ok(newPassword);
    assert.equal(newPassword.authType, 'password');
    assert.equal(newPassword.password, 'replacement password');
    assert.equal(newPassword.privateKey, undefined);
    assert.equal(newPassword.passphrase, undefined);
    assert.equal(newPassword.proxyJump, 'new-jump');

    const reconfigured = manager.updateHost(original.id, {
      host: 'newer.example.test',
      username: 'new-user',
      authType: 'privateKey',
      privateKeyPath: '~/.ssh/new-key',
      passphrase: 'new passphrase'
    });
    assert.ok(reconfigured);
    assert.equal(reconfigured.password, undefined);
    assert.equal(reconfigured.authType, 'privateKey');
    assert.equal(reconfigured.privateKeyPath, '~/.ssh/new-key');
    assert.equal(reconfigured.passphrase, 'new passphrase');

    const renamed = manager.updateHost(original.id, { name: 'new production', notes: 'keep credentials' });
    assert.ok(renamed);
    assert.equal(renamed.privateKeyPath, '~/.ssh/new-key');
    assert.equal(renamed.passphrase, 'new passphrase');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('ConfigManager: exporting hosts atomically protects existing files with private permissions', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sshx-export-hosts-'));
  const manager = new ConfigManager(path.join(temporary, 'config'));
  const destination = path.join(temporary, 'nested', 'hosts.json');
  try {
    manager.addHost({ name: 'production', host: 'prod.example.test', password: 'secret' });
    fs.mkdirSync(path.dirname(destination));
    fs.writeFileSync(destination, 'previous export');
    const json = manager.exportHosts(destination);

    assert.equal(fs.readFileSync(destination, 'utf8'), json);
    assert.deepEqual(fs.readdirSync(path.dirname(destination)), ['hosts.json']);
    if (process.platform !== 'win32') assert.equal(fs.statSync(destination).mode & 0o777, 0o600);

    const newDestination = path.join(temporary, 'new', 'private', 'hosts.json');
    manager.exportHosts(newDestination);
    assert.equal(fs.readFileSync(newDestination, 'utf8'), json);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(path.dirname(newDestination)).mode & 0o777, 0o700);
      assert.equal(fs.statSync(newDestination).mode & 0o777, 0o600);
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('ConfigManager: invalid app settings never silently reset host key policy', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sshx-invalid-app-'));
  try {
    const manager = new ConfigManager(temporary);
    const configFile = manager.getConfigFilePath();
    manager.saveAppConfig({ strictHostKeyChecking: 'yes' });
    assert.equal(manager.getAppConfig().strictHostKeyChecking, 'yes');
    if (process.platform !== 'win32') assert.equal(fs.statSync(configFile).mode & 0o777, 0o600);

    for (const invalid of ['{', 'null', '{"strictHostKeyChecking":"invalid"}']) {
      fs.writeFileSync(configFile, invalid);
      assert.throws(() => manager.getAppConfig(), /Invalid (JSON|app configuration)/);
      assert.throws(() => manager.saveAppConfig({ theme: 'dark' }), /Invalid (JSON|app configuration)/);
      assert.equal(fs.readFileSync(configFile, 'utf8'), invalid);
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('KnownHostsManager: unreadable known hosts cannot be treated as an empty trust store', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sshx-invalid-known-hosts-'));
  try {
    const manager = new KnownHostsManager(temporary);
    assert.throws(() => manager.getEntries(), /Could not read known hosts file/);
    assert.throws(() => manager.verifyHostKey('example.test', 22, 'ssh-rsa', Buffer.from('host key')),
      /Could not read known hosts file/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('KnownHostsManager: accept-new refuses a host when its key cannot be persisted', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sshx-unwritable-known-hosts-'));
  try {
    const manager = new KnownHostsManager(path.join(temporary, 'known_hosts'));
    manager.addHostKey = () => { throw new Error('read-only filesystem'); };
    const result = manager.verifyHostKey('example.test', 22, 'ssh-rsa', Buffer.from('host key'));
    assert.equal(result.status, 'mismatch');
    assert.match(result.message, /Could not persist the host key/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
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

test('OpenSSH config string and file parsers agree on authentication directives', () => {
  const contents = 'Host password-host\n  HostName example.test\n  PreferredAuthentications password,publickey\n  ServerAliveInterval 10\n';
  const filename = path.join(tempConfigDir, 'ssh-auth-config');
  fs.writeFileSync(filename, contents);

  const expected = parseOpenSSHConfig(contents);
  assert.equal(expected[0].authType, 'password');
  assert.deepEqual(parseOpenSSHConfigFile(filename), expected);
});

test('OpenSSH config Include wildcard only imports matching files', () => {
  const directory = path.join(tempConfigDir, 'ssh-include-files');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'one.conf'), 'Host included-one\n');
  fs.writeFileSync(path.join(directory, 'oneXconf'), 'Host excluded-one\n');
  const configPath = path.join(tempConfigDir, 'ssh-included-config');
  fs.writeFileSync(configPath, 'Include ssh-include-files/*.conf\n');

  assert.deepEqual(parseOpenSSHConfigFile(configPath).map(host => host.name), ['included-one']);
});

test('Host suggestions compute edit distance without a quadratic matrix', () => {
  assert.equal(calculateLevenshteinDistance('server', 'server'), 0);
  assert.equal(calculateLevenshteinDistance('server', 'sever'), 1);
  assert.equal(calculateLevenshteinDistance('db-primary', 'db-secondary'), 6);
  assert.equal(calculateLevenshteinDistance('long-hostname', ''), 13);
});

test('KeyManager: generated keys parse and match the exported public keys', () => {
  for (const type of ['ed25519', 'rsa'] as const) {
    for (const passphrase of [undefined, 'keygen-test-passphrase']) {
      const key = KeyManager.generateKeyPair({ type, bits: 2048, comment: 'test-key', passphrase });
      const parsed = ssh2.utils.parseKey(key.privateKeyPem, passphrase);
      assert.ok(!(parsed instanceof Error), String(parsed));
      const [algorithm, publicKey] = key.publicKeyOpenSSH.split(' ');
      assert.equal(algorithm, `ssh-${type}`);
      assert.equal(parsed.getPublicSSH().toString('base64'), publicKey);
      assert.ok(key.fingerprintSha256.startsWith('SHA256:'));
      if (passphrase) assert.ok(ssh2.utils.parseKey(key.privateKeyPem) instanceof Error);
    }
  }
});

test('KeyManager: saves new key pairs without replacing existing files', () => {
  const keyPath = path.join(tempConfigDir, 'id_test_ed25519');
  const files = KeyManager.saveKeyPairToDisk(keyPath, { type: 'ed25519', comment: 'original-key' });
  const originalPrivate = fs.readFileSync(files.privateKeyPath);
  const originalPublic = fs.readFileSync(files.publicKeyPath);
  assert.throws(() => KeyManager.saveKeyPairToDisk(keyPath, { comment: 'replacement' }), { code: 'EEXIST' });
  assert.deepEqual(fs.readFileSync(files.privateKeyPath), originalPrivate);
  assert.deepEqual(fs.readFileSync(files.publicKeyPath), originalPublic);
  if (process.platform !== 'win32') assert.equal(fs.statSync(keyPath).mode & 0o777, 0o600);

  const publicOnlyPath = path.join(tempConfigDir, 'id_public_only');
  fs.writeFileSync(`${publicOnlyPath}.pub`, originalPublic);
  assert.throws(() => KeyManager.saveKeyPairToDisk(publicOnlyPath, {}), { code: 'EEXIST' });
  assert.equal(fs.existsSync(publicOnlyPath), false);
  assert.deepEqual(fs.readFileSync(`${publicOnlyPath}.pub`), originalPublic);
});

test('SSHConnection: authenticates with a newly generated encrypted Ed25519 key', async () => {
  const privateKeyPath = path.join(tempConfigDir, 'id_generated_login');
  const passphrase = 'login-test-passphrase';
  KeyManager.saveKeyPairToDisk(privateKeyPath, { type: 'ed25519', passphrase });
  const connection = new SSHConnection({
    profile: {
      id: 'generated-key-test', name: 'generated-key-test', host: '127.0.0.1', port: serverPort,
      username: 'testuser', authType: 'privateKey', privateKeyPath, passphrase
    },
    configManager,
    knownHostsManager: testKnownHosts
  });
  try {
    await connection.connect();
    const result = await execCommand(connection.getRawClient(), 'echo hello');
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'hello\n');
  } finally {
    connection.disconnect();
  }
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

test('SSHConnection: ProxyCommand streams a connection to the SSH server', async () => {
  const helperPath = fileURLToPath(new URL('./proxy-command-helper.ts', import.meta.url));
  const proxyCommand = `node --import tsx "${helperPath}" ${serverPort}`;
  const connection = new SSHConnection({
    profile: {
      id: 'proxy-command-test', name: 'proxy-command-test', host: '127.0.0.1', port: serverPort,
      username: 'testuser', authType: 'password', password: 'testpass', proxyCommand
    },
    configManager,
    knownHostsManager: testKnownHosts
  });

  try {
    await connection.connect();
    const result = await execCommand(connection.getRawClient(), 'echo proxy-command-ok');
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), 'Executed: echo proxy-command-ok');
  } finally {
    connection.disconnect();
  }
});

test('SSHConnection: reports ProxyCommand process failures', async () => {
  const connection = new SSHConnection({
    profile: {
      id: 'proxy-command-failure-test', name: 'proxy-command-failure-test', host: '127.0.0.1', port: serverPort,
      username: 'testuser', authType: 'password', password: 'testpass',
      proxyCommand: 'node -e "process.exit(23)"'
    },
    configManager,
    knownHostsManager: testKnownHosts
  });

  try {
    await assert.rejects(connection.connect(), /ProxyCommand exited with status 23/);
  } finally {
    connection.disconnect();
  }
});

test('SSHConnection: concurrent connect calls share the same handshake', async context => {
  const profile = {
    id: 'concurrent-test', name: 'concurrent-test', host: '127.0.0.1', port: serverPort,
    username: 'testuser', authType: 'agent' as const
  };
  const connection = new SSHConnection({ profile, configManager, knownHostsManager: testKnownHosts });
  const client = connection.getRawClient();
  const connect = context.mock.method(client, 'connect', () => client);

  const pending = [connection.connect(), connection.connect()];
  assert.equal(connect.mock.callCount(), 1);
  client.emit('ready');
  await Promise.all(pending);
  connection.disconnect();
});

test('SSHConnection: rejects ProxyJump cycles before opening a socket', async () => {
  const first = configManager.addHost({
    name: 'cycle-first', host: 'first.example.test', proxyJump: 'cycle-second'
  });
  const second = configManager.addHost({
    name: 'cycle-second', host: 'second.example.test', proxyJump: first.id
  });
  const connection = new SSHConnection({ profile: first, configManager, knownHostsManager: testKnownHosts });
  try {
    await assert.rejects(connection.connect(), /ProxyJump cycle detected/);
    assert.equal(connection.connected(), false);
  } finally {
    connection.disconnect();
    configManager.deleteHost(first.id);
    configManager.deleteHost(second.id);
  }
});

test('SSHConnection: zero keepalive interval disables SSH2 keepalive', async context => {
  const profile = {
    id: 'no-keepalive', name: 'no-keepalive', host: '127.0.0.1', port: serverPort,
    username: 'testuser', authType: 'agent' as const, keepaliveInterval: 0
  };
  const connection = new SSHConnection({ profile, configManager, knownHostsManager: testKnownHosts });
  const client = connection.getRawClient();
  const connect = context.mock.method(client, 'connect', () => client);

  const pending = connection.connect();
  assert.equal(connect.mock.calls[0].arguments[0].keepaliveInterval, 0);
  client.emit('ready');
  await pending;
  connection.disconnect();
});

test('SSHConnection: handles a transport error after ready and closes before ready', async (context) => {
  const profile = {
    id: 'transport-test', name: 'transport-test', host: '127.0.0.1', port: serverPort,
    username: 'testuser', authType: 'agent' as const
  };
  const connection = new SSHConnection({ profile, configManager, knownHostsManager: testKnownHosts });
  const transport = connection.getRawClient();
  context.mock.method(transport, 'connect', () => transport);

  const handshake = connection.connect();
  transport.emit('close');
  await assert.rejects(handshake, /closed before authentication/);

  const nextHandshake = connection.connect();
  transport.emit('ready');
  await nextHandshake;
  assert.equal(connection.connected(), true);
  assert.doesNotThrow(() => transport.emit('error', new Error('test connection lost')));
  assert.equal(connection.connected(), false);
  transport.emit('close');
  assert.equal(transport.listenerCount('error'), 0);
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

  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshx-upload-test-'));
  try {
    const source = path.join(uploadDir, 'source.txt');
    fs.writeFileSync(source, 'Uploaded over SFTP');
    await sftp.uploadFile(source, 'uploaded.txt');
    assert.equal(await sftp.readFile('uploaded.txt'), 'Uploaded over SFTP');
    await sftp.rm('uploaded.txt');

    fs.writeFileSync(source, '');
    await sftp.uploadFile(source, 'empty.txt');
    assert.equal(await sftp.readFile('empty.txt'), '');
    await sftp.rm('empty.txt');
  } finally {
    fs.rmSync(uploadDir, { recursive: true, force: true });
  }

  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshx-download-test-'));
  try {
    const localPath = path.join(downloadDir, 'hello.txt');
    fs.writeFileSync(localPath, 'previous content');
    await sftp.downloadFile('hello.txt', localPath);
    assert.equal(fs.readFileSync(localPath, 'utf8'), content);
    assert.deepEqual(fs.readdirSync(downloadDir), ['hello.txt']);
  } finally {
    fs.rmSync(downloadDir, { recursive: true, force: true });
  }

  // List directory
  const files = await sftp.list('.');
  const found = files.find(f => f.filename === 'hello.txt');
  assert.ok(found);
  assert.equal(found.filename, 'hello.txt');
  assert.equal(files.some(file => file.filename.includes('.sshx-')), false);

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

test('TuiApp: form save and cancel keep raw input, unlike SSH handoff', async (context) => {
  const setRawMode = context.mock.fn();
  const resume = context.mock.fn();
  const input = Object.assign(new EventEmitter(), { isTTY: true, setRawMode, resume });
  context.mock.getter(process, 'stdin', () => input as unknown as typeof process.stdin);
  const app = new TuiApp() as any;
  context.mock.method(app.screen, 'flush', () => {});
  const fields = [{ key: 'name', label: 'name', value: '' }];

  const submission = app.editForm('New host', fields);
  assert.equal(app.inModal, true);
  input.emit('keypress', 'x', { name: 'x' });
  input.emit('keypress', '\x13', { name: 's', ctrl: true });
  assert.deepEqual(await submission, { name: 'x' });
  assert.equal(app.inModal, false);

  const cancellation = app.editForm('Edit host', fields);
  input.emit('keypress', undefined, { name: 'escape' });
  assert.equal(await cancellation, null);
  assert.equal(app.inModal, false);
  assert.equal(input.listenerCount('keypress'), 0);
  assert.equal(setRawMode.mock.callCount(), 0);

  app.suspendForConnection();
  assert.equal(app.inModal, true);
  app.resumeAfterConnection();
  assert.equal(app.inModal, false);
  assert.deepEqual(setRawMode.mock.calls.map(call => call.arguments[0]), [false, true]);
  assert.equal(resume.mock.callCount(), 1);
});

test('computeTableLayout: eliminates center gap and sizes columns proportionally', () => {
  const sampleHosts = [
    {
      id: '1',
      name: '66云美国',
      host: '216.167.54.250',
      port: 22,
      username: 'root',
      authType: 'privateKey' as const,
      privateKeyPath: '~/.ssh/id_ed25519',
      notes: 'Debian GNU/Linux 12 (bookworm)'
    },
    {
      id: '2',
      name: '美国vps家宽',
      host: '216.167.74.174',
      port: 38566,
      username: 'root',
      authType: 'privateKey' as const,
      privateKeyPath: '~/.ssh/keys/us-vps-home.key',
      tags: ['生产', 'vps'],
      notes: 'CentOS Stream 9'
    },
    {
      id: '3',
      name: 'HQT本地Git运维',
      host: '192.168.100.72',
      port: 22,
      username: 'root',
      authType: 'privateKey' as const,
      tags: ['红蜻蜓', '本地', 'git', '运维'],
      notes: 'Debian 12'
    }
  ];

  // Wide terminal (220 cols, like user's screen in Image #2)
  const wide = computeTableLayout(220, sampleHosts);
  // DEST column must NOT absorb 100+ chars
  assert.ok(wide.dest <= 32, `dest width should be reasonably bounded, got ${wide.dest}`);
  assert.ok(wide.dest >= 26, `dest width should comfortably fit content, got ${wide.dest}`);
  // AUTH column should fit 'key:us-vps-home.key' (20 chars) without truncation
  assert.ok(wide.auth >= 20, `auth width should fit key name, got ${wide.auth}`);
  // TAGS column should fit content
  assert.ok(wide.tags >= 18, `tags width should fit tags, got ${wide.tags}`);
  // NOTES column should be activated on wide screens
  assert.ok(wide.notes !== undefined && wide.notes >= 20, `notes column should be active on wide screen, got ${wide.notes}`);
  assert.equal(wide.gap, 2);

  // Normal terminal (100 cols)
  const normal = computeTableLayout(100, sampleHosts);
  assert.ok(normal.dest <= 32);
  assert.ok(normal.totalWidth <= 100);

  // Narrow terminal (60 cols)
  const narrow = computeTableLayout(60, sampleHosts);
  assert.ok(narrow.totalWidth <= 60, `narrow totalWidth (${narrow.totalWidth}) should fit in 60 cols`);
  assert.equal(narrow.gap, 1);
});


