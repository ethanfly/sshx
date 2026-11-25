import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import os from 'node:os';
import ssh2 from 'ssh2';
import {
  ConfigManager,
  KnownHostsManager,
  KeyManager,
  SSHConnection,
  InteractiveSession,
  resolveSshAgent,
  execCommand,
  expandProxyCommand,
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

test('ConfigManager: construction and reads have no filesystem side effects', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sshx-lazy-config-'));
  const configDir = path.join(temporary, 'config');
  try {
    const manager = new ConfigManager(configDir);
    assert.deepEqual(manager.getHosts(), []);
    assert.equal(manager.getHost('missing'), undefined);
    assert.equal(fs.existsSync(configDir), false);

    manager.addHost({ name: 'first', host: 'first.example.test' });
    assert.deepEqual(fs.readdirSync(configDir), ['hosts.json']);
    if (process.platform !== 'win32') assert.equal(fs.statSync(configDir).mode & 0o777, 0o700);
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

test('KnownHostsManager: honours OpenSSH host patterns, revoked keys and CA markers', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sshx-known-host-patterns-'));
  try {
    const file = path.join(temporary, 'known_hosts');
    const [trusted, rotated, revoked, authority] = ['trusted', 'rotated', 'revoked', 'authority']
      .map(name => Buffer.from(`host-key-${name}`));
    const original = [
      `*.corp.test,!bastion.corp.test ssh-ed25519 ${trusted.toString('base64')}`,
      `[Build.Example.test]:2222 ssh-ed25519 ${trusted.toString('base64')}`,
      `@revoked * ssh-ed25519 ${revoked.toString('base64')}`,
      `@cert-authority *.ca.test ssh-ed25519 ${authority.toString('base64')}`,
      ''
    ].join('\n');
    fs.writeFileSync(file, original);
    const manager = new KnownHostsManager(file);
    const verify = (host: string, port: number, key: Buffer, mode: 'yes' | 'accept-new' = 'yes') =>
      manager.verifyHostKey(host, port, 'ssh-ed25519', key, mode);

    assert.equal(verify('web.corp.test', 22, trusted).status, 'trusted');
    assert.equal(verify('WEB.Corp.test', 22, trusted).status, 'trusted');
    assert.equal(verify('build.example.test', 2222, trusted).status, 'trusted');
    assert.match(verify('web.corp.test', 22, rotated, 'accept-new').message, /REMOTE HOST IDENTIFICATION HAS CHANGED/);
    assert.match(verify('bastion.corp.test', 22, trusted).message, /is not known/);
    assert.match(verify('node.ca.test', 22, authority).message, /is not known/);
    const revokedResult = verify('fresh.example.test', 22, revoked, 'accept-new');
    assert.equal(revokedResult.status, 'mismatch');
    assert.match(revokedResult.message, /has been revoked/);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.deepEqual(manager.getEntries().map(entry => entry.marker), [undefined, undefined, 'revoked', 'cert-authority']);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('KnownHostsManager: accept-new never glues a key onto a final line without a newline', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sshx-known-host-newline-'));
  try {
    const file = path.join(temporary, 'known_hosts');
    fs.writeFileSync(file, 'old.example.test ssh-ed25519 b2xk');
    const manager = new KnownHostsManager(file);
    assert.equal(manager.verifyHostKey('new.example.test', 22, 'ssh-ed25519', Buffer.from('new'), 'accept-new').status, 'new');
    assert.deepEqual(manager.getEntries().map(entry => [entry.host, entry.publicKey]), [
      ['old.example.test', 'b2xk'],
      ['new.example.test', Buffer.from('new').toString('base64')]
    ]);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('KnownHostsManager: constructing the default store does not touch the filesystem', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sshx-known-host-home-'));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  try {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    const manager = new KnownHostsManager();
    assert.equal(manager.getFilePath(), path.join(home, '.sshx', 'known_hosts'));
    assert.deepEqual(fs.readdirSync(home), []);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
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

test('KeyManager: retries when ssh2 generates a malformed Ed25519 public key', () => {
  const generate = ssh2.utils.generateKeyPairSync;
  let calls = 0;
  try {
    ssh2.utils.generateKeyPairSync = ((...args: Parameters<typeof generate>) => {
      calls++;
      if (calls === 1) return { private: 'invalid', public: 'ssh-ed25519 AAA=' };
      return generate(...args);
    }) as typeof generate;

    const key = KeyManager.generateKeyPair({ type: 'ed25519', comment: 'retry-test' });
    assert.equal(calls, 2);
    assert.ok(!(ssh2.utils.parseKey(key.privateKeyPem) instanceof Error));
  } finally {
    ssh2.utils.generateKeyPairSync = generate;
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

test('expandProxyCommand: expands OpenSSH tokens and refuses shell syntax in names', () => {
  const profile = { host: 'Example.test', port: 2222, username: 'deploy' };
  assert.equal(expandProxyCommand('nc %h %p # %r@%n %% %%h', profile), 'nc Example.test 2222 # deploy@Example.test % %h');
  assert.equal(expandProxyCommand('nc %h %p', { host: 'fe80::1%eth0', username: 'u' }), 'nc fe80::1%eth0 22');
  assert.equal(expandProxyCommand('nc %h %p', { ...profile, username: '$(id)' }), 'nc Example.test 2222');
  for (const host of ['evil.test;touch pwned', 'evil.test$(id)', 'a b', '-oProxyCommand=x', 'line\nbreak']) {
    assert.throws(() => expandProxyCommand('nc %h %p', { ...profile, host }), /contains shell metacharacters/);
  }
  assert.throws(() => expandProxyCommand('ssh -W %h:%p %r@jump', { ...profile, username: '`id`' }), /Refusing to expand %r/);
});

test('SSHConnection: expands %h/%p in ProxyCommand and never spawns it for unsafe host names', async () => {
  const relay = "const s=require('net').connect(+process.argv[2],process.argv[1]);process.stdin.pipe(s).pipe(process.stdout)";
  const proxyCommand = `"${process.execPath}" -e "${relay}" %h %p`;
  const profile = {
    id: 'proxied', name: 'proxied', host: '127.0.0.1', port: serverPort,
    username: 'testuser', authType: 'password' as const, password: 'testpass', proxyCommand
  };
  const conn = new SSHConnection({ profile, configManager, knownHostsManager: testKnownHosts });
  try {
    await conn.connect();
    const result = await execCommand(conn.getRawClient(), 'echo hello');
    assert.equal(result.stdout.trim(), 'hello');
  } finally {
    conn.disconnect();
  }

  const unsafe = new SSHConnection({
    profile: { ...profile, host: '127.0.0.1;touch pwned' }, configManager, knownHostsManager: testKnownHosts
  });
  await assert.rejects(unsafe.connect(), /contains shell metacharacters/);
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

test('SSHConnection: an immediate retry ignores the failed socket and keeps one responder', async () => {
  const probe = net.createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const closedPort = (probe.address() as AddressInfo).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));

  const connection = new SSHConnection({
    profile: {
      id: 'retry-keyboard', name: 'retry-keyboard', host: '127.0.0.1', port: closedPort,
      username: 'testuser', authType: 'password', password: 'pw'
    },
    configManager,
    knownHostsManager: testKnownHosts
  });
  try {
    await assert.rejects(connection.connect(), /ECONNREFUSED/);
    await assert.rejects(connection.connect(), /ECONNREFUSED/);
    assert.equal(connection.getRawClient().listenerCount('keyboard-interactive'), 1);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(connection.getRawClient().listenerCount('error'), 0);
  } finally {
    connection.disconnect();
  }
});

test('SSHConnection: forwards the banner and keyboard-interactive prompts to callbacks', async () => {
  const server = new ssh2.Server({ hostKeys: [mockServer.hostKeyPem], banner: 'Authorized use only' }, client => {
    client.on('error', () => {});
    client.on('authentication', ctx => {
      if (ctx.method !== 'keyboard-interactive') return ctx.reject(['keyboard-interactive']);
      ctx.prompt([{ prompt: 'Verification code: ', echo: true }], answers => {
        if (answers[0] === '424242') ctx.accept();
        else ctx.reject();
      });
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  const banners: string[] = [];
  const prompts: Array<{ prompt: string; echo: boolean }> = [];
  const connection = new SSHConnection({
    profile: {
      id: 'keyboard-callback', name: 'keyboard-callback', host: '127.0.0.1', port,
      username: 'testuser', authType: 'keyboard-interactive'
    },
    configManager,
    knownHostsManager: testKnownHosts,
    onBanner: message => banners.push(message),
    onKeyboardInteractive: (_name, _instructions, _lang, asked, finish) => {
      prompts.push(...asked);
      finish(['424242']);
    }
  });
  try {
    await connection.connect();
    assert.equal(connection.connected(), true);
    assert.equal(banners.length, 1);
    assert.match(banners[0], /Authorized use only/);
    assert.deepEqual(prompts, [{ prompt: 'Verification code: ', echo: true }]);
  } finally {
    connection.disconnect();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
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

test('ConfigManager: updateHost clears optional fields via null and getAppConfig is side-effect free', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sshx-clear-fields-'));
  const configDir = path.join(temporary, 'cfg');
  try {
    const manager = new ConfigManager(configDir);
    const defaults = manager.getAppConfig();
    assert.equal(defaults.sidebarDefault, 'auto');
    assert.equal(defaults.sidebarHotkey, 'f2');
    assert.equal(fs.existsSync(configDir), false);

    const host = manager.addHost({
      name: 'clearable',
      host: '10.0.0.10',
      authType: 'privateKey',
      password: 'secret',
      privateKeyPath: '~/.ssh/custom',
      passphrase: 'keypw',
      proxyJump: 'bastion',
      proxyCommand: 'nc %h %p',
      notes: 'initial note'
    });

    const cleared = manager.updateHost(host.id, {
      password: null,
      privateKeyPath: null,
      proxyJump: null,
      proxyCommand: null,
      notes: null
    });
    assert.ok(cleared);
    assert.equal(cleared.password, undefined);
    assert.equal(cleared.privateKeyPath, undefined);
    assert.equal(cleared.passphrase, undefined);
    assert.equal(cleared.proxyJump, undefined);
    assert.equal(cleared.proxyCommand, undefined);
    assert.equal(cleared.notes, undefined);
    assert.equal(cleared.host, '10.0.0.10');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('OpenSSH config parser handles Match blocks, multi-alias, equals syntax, comments, Host *, and broken symlinks', () => {
  const parsed = parseOpenSSHConfig(`
Host web1 web2 *.web !excluded # production web
  HostName="10.0.1.10" # inline comment
  Port=2222
  User = deploy
  IdentityFile "~/.ssh/web_key"

Match host *.internal exec "test -f /tmp/x"
  User match-user
  Port 9999
  IdentityFile ~/.ssh/match_key

Host db
  HostName "10.0.2.20#tag"

Host *
  User fallback-user
  Port 2200
  ServerAliveInterval 30
`);

  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].name, 'web1');
  assert.equal(parsed[0].host, '10.0.1.10');
  assert.equal(parsed[0].port, 2222);
  assert.equal(parsed[0].username, 'deploy');
  assert.equal(parsed[0].privateKeyPath, '~/.ssh/web_key');
  assert.equal(parsed[0].keepaliveInterval, 30000);

  assert.equal(parsed[1].name, 'web2');
  assert.equal(parsed[1].host, '10.0.1.10');
  assert.equal(parsed[1].username, 'deploy');

  assert.equal(parsed[2].name, 'db');
  assert.equal(parsed[2].host, '10.0.2.20#tag');
  assert.equal(parsed[2].username, 'fallback-user');
  assert.equal(parsed[2].port, 2200);

  // Include with multiple patterns, directory wildcards, and a broken symlink
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sshx-openssh-include-'));
  try {
    const subA = path.join(temporary, 'conf.a');
    const subB = path.join(temporary, 'conf.b');
    fs.mkdirSync(subA);
    fs.mkdirSync(subB);
    fs.writeFileSync(path.join(subA, 'a.conf'), 'Host alpha\n  HostName 10.1.0.1\n');
    fs.writeFileSync(path.join(subB, 'b.conf'), 'Host beta\n  HostName 10.1.0.2\n');
    fs.symlinkSync(path.join(temporary, 'missing-target'), path.join(subA, 'broken.conf'));
    const main = path.join(temporary, 'config');
    fs.writeFileSync(main, 'Include conf.*/*.conf\n');

    const included = parseOpenSSHConfigFile(main);
    assert.deepEqual(included.map(h => h.name), ['alpha', 'beta']);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('KeyManager.listAvailableKeys scans configured dir without duplicates and ignores large non-key files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshx-keys-scan-'));
  try {
    const keyPath = path.join(dir, 'id_ed25519');
    KeyManager.saveKeyPairToDisk(keyPath, { type: 'ed25519', comment: 'scan-test' });
    fs.writeFileSync(path.join(dir, 'large_blob.bin'), Buffer.alloc(1024 * 1024, 0x41));

    const found = KeyManager.listAvailableKeys([dir, dir]);
    const matches = found.filter(k => k.path === keyPath);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].type, 'ed25519');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SSHConnection: resolveSshAgent, multi-hop inline ProxyJump forwarding callbacks, and InteractiveSession env', async () => {
  assert.equal(resolveSshAgent('linux', { SSH_AUTH_SOCK: '/tmp/agent.sock' }), '/tmp/agent.sock');
  assert.equal(resolveSshAgent('win32', {}), '\\\\.\\pipe\\openssh-ssh-agent');
  assert.equal(resolveSshAgent('linux', {}), undefined);

  const banners: string[] = [];
  const kbiPrompts: string[] = [];
  const jumpServer = new ssh2.Server({ hostKeys: [mockServer.hostKeyPem], banner: 'Bastion Notice' }, client => {
    client.on('error', () => {});
    client.on('authentication', ctx => {
      if (ctx.method !== 'keyboard-interactive') return ctx.reject(['keyboard-interactive']);
      ctx.prompt([{ prompt: 'OTP: ', echo: false }], answers => {
        if (answers[0] === '654321') ctx.accept();
        else ctx.reject();
      });
    });
    client.on('ready', () => {
      client.on('tcpip', (accept, _reject, info) => {
        const stream = accept();
        const sock = net.connect(info.destPort, info.destIP, () => {
          stream.pipe(sock).pipe(stream);
        });
        sock.on('error', () => stream.close());
      });
    });
  });
  await new Promise<void>(resolve => jumpServer.listen(0, '127.0.0.1', resolve));
  const jumpPort = (jumpServer.address() as AddressInfo).port;

  const conn = new SSHConnection({
    profile: {
      id: 'multi-hop-test',
      name: 'multi-hop-test',
      host: '127.0.0.1',
      port: serverPort,
      username: 'testuser',
      authType: 'password',
      password: 'testpass',
      proxyJump: `testuser@127.0.0.1:${jumpPort}`
    },
    configManager,
    knownHostsManager: testKnownHosts,
    onBanner: msg => banners.push(msg),
    onKeyboardInteractive: (_n, _i, _l, prompts, finish) => {
      kbiPrompts.push(...prompts.map(p => p.prompt));
      finish(['654321']);
    }
  });

  try {
    await conn.connect();
    const res = await execCommand(conn.getRawClient(), 'echo hello');
    assert.equal(res.stdout.trim(), 'hello');
    assert.ok(banners.some(b => b.includes('Bastion Notice')));
    assert.deepEqual(kbiPrompts, ['OTP: ']);
  } finally {
    conn.disconnect();
    await new Promise<void>(resolve => jumpServer.close(() => resolve()));
  }

  let receivedShellArgs: unknown[] = [];
  const envSession = new InteractiveSession({
    shell(...args: unknown[]) {
      receivedShellArgs = args.slice(0, -1);
      const cb = args[args.length - 1] as (err: Error | undefined, ch: unknown) => void;
      const ch = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), close() {} });
      cb(undefined, ch);
    }
  } as any, { env: { MY_VAR: '123' } });
  await envSession.start();
  assert.equal(receivedShellArgs.length, 2);
  assert.deepEqual(receivedShellArgs[1], { env: { MY_VAR: '123' } });
  envSession.close();
});

test('TuiApp: search mode isolates hotkeys and runForm supports paste, emoji, secret cursor, and hints', async (context) => {
  const input = Object.assign(new EventEmitter(), { isTTY: true, setRawMode() {}, resume() {} });
  context.mock.getter(process, 'stdin', () => input as unknown as typeof process.stdin);
  const app = new TuiApp() as any;
  const writes: string[] = [];
  context.mock.method(app.screen, 'flush', () => {
    writes.push(app.screen.buffer.join(''));
    app.screen.buffer = [];
  });

  // In normal mode, '/' enters search mode; typing 'd', 'e', 'v', 'a', 'j', 'k' updates filter without triggering modals
  await app.handleInput('/', { name: '/' });
  assert.equal(app.hostsScreen.searchMode, true);
  for (const ch of ['d', 'e', 'v', 'a', 'j', 'k', 'S', '*']) {
    await app.handleInput(ch, { name: ch });
  }
  assert.equal(app.hostsScreen.filterQuery, 'devajkS*');
  assert.equal(app.inModal, false);

  await app.handleInput(undefined, { name: 'escape' });
  assert.equal(app.hostsScreen.searchMode, false);
  assert.equal(app.hostsScreen.filterQuery, 'devajkS*');

  const quitAfterClear = await app.handleInput(undefined, { name: 'escape' });
  assert.equal(quitAfterClear, false);
  assert.equal(app.hostsScreen.filterQuery, '');

  // Test runForm paste, emoji, secret cursor left movement, and activeHint rendering
  const fields = [
    { key: 'name', label: 'name', value: '', hint: 'pick a friendly alias' },
    { key: 'secret', label: 'secret', value: '', secret: true }
  ];
  const pending = app.editForm('Paste Test', fields);
  assert.ok(writes.at(-1)?.includes('pick a friendly alias'));
  input.emit('keypress', 'prod🔑', {});
  input.emit('keypress', undefined, { name: 'tab' });
  input.emit('keypress', 'abcd', {});
  input.emit('keypress', undefined, { name: 'left' });
  input.emit('keypress', 'X', {});
  input.emit('keypress', '\x13', { name: 's', ctrl: true });
  assert.deepEqual(await pending, { name: 'prod🔑', secret: 'abcXd' });
});


