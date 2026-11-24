import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sshx-target-test-'));
const previousEnv = {
  SSHX_CONFIG_DIR: process.env.SSHX_CONFIG_DIR,
  SSHX_HOSTS_FILE: process.env.SSHX_HOSTS_FILE,
  SSHX_CONFIG_FILE: process.env.SSHX_CONFIG_FILE,
  SSH_PASSWORD: process.env.SSH_PASSWORD
};
process.env.SSHX_CONFIG_DIR = temporary;
delete process.env.SSHX_HOSTS_FILE;
delete process.env.SSHX_CONFIG_FILE;
delete process.env.SSH_PASSWORD;

const { defaultConfigManager } = await import('../dist/core/config.js');
const { resolveTarget } = await import('../dist/cli/connect.js');

after(() => {
  for (const [name, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(temporary, { recursive: true, force: true });
});

test('saved endpoints retain credentials only when host, port and user are unchanged', () => {
  const saved = defaultConfigManager.addHost({
    name: 'credential-test',
    host: 'original.example.test',
    port: 2222,
    username: 'old-user',
    authType: 'privateKey',
    password: 'old-password',
    privateKey: 'old-inline-key',
    privateKeyPath: '~/.ssh/old-key',
    passphrase: 'old-phrase',
    proxyJump: 'old-jump',
    proxyCommand: 'old-proxy'
  });

  const sameEndpoint = resolveTarget(saved.name, { port: 2222, user: 'old-user' });
  assert.equal(sameEndpoint.password, 'old-password');
  assert.equal(sameEndpoint.privateKey, 'old-inline-key');
  assert.equal(sameEndpoint.proxyJump, 'old-jump');

  for (const changed of [
    resolveTarget(`new-user@${saved.name}`),
    resolveTarget(saved.name, { port: 2223 })
  ]) {
    assert.equal(changed.id, saved.id);
    assert.equal(changed.authType, 'password');
    for (const field of ['password', 'privateKey', 'privateKeyPath', 'passphrase', 'proxyJump', 'proxyCommand'] as const) {
      assert.equal(changed[field], undefined, `${field} must not cross endpoints`);
    }
  }

  const explicitlyConfigured = resolveTarget(saved.name, {
    port: 2223,
    password: 'new-password',
    jump: 'new-jump'
  });
  assert.equal(explicitlyConfigured.password, 'new-password');
  assert.equal(explicitlyConfigured.proxyJump, 'new-jump');
  assert.equal(explicitlyConfigured.privateKey, undefined);
  assert.equal(explicitlyConfigured.proxyCommand, undefined);
});

test('direct targets parse IPv6 and honor explicit username and port flags', () => {
  const options = { password: 'provided' };
  assert.deepEqual(
    (({ host, port, username }) => ({ host, port, username }))(resolveTarget('alice@[2001:db8::1]:2200', options)),
    { host: '2001:db8::1', port: 2200, username: 'alice' }
  );
  assert.equal(resolveTarget('::1', options).host, '::1');
  assert.deepEqual(
    (({ host, port, username }) => ({ host, port, username }))(resolveTarget('alice@[::1]:2200', {
      ...options, user: 'bob', port: 2201
    })),
    { host: '::1', port: 2201, username: 'bob' }
  );
  assert.deepEqual(
    (({ host, port, username }) => ({ host, port, username }))(resolveTarget('alice@example.test:2200', {
      ...options, user: 'bob', port: 2201
    })),
    { host: 'example.test', port: 2201, username: 'bob' }
  );
});

test('invalid direct target syntax and port values fail before attempting SSH', () => {
  for (const target of ['alice@', 'alice@@host', 'host:', 'host:abc', 'host:0', '[::1', '[::1]:99999', '[::1]:', 'alice@host:']) {
    assert.throws(() => resolveTarget(target, { password: 'provided' }), /Invalid (SSH target|SSH port)/, target);
  }
  for (const port of ['nope', 0, 65536, 1.5]) {
    assert.throws(() => resolveTarget('example.test', { port, password: 'provided' }), /Invalid SSH port/, String(port));
  }
});

test('explicit identity and password do not reuse other saved authentication fields', () => {
  const saved = defaultConfigManager.addHost({
    name: 'explicit-auth-test', host: 'auth.example.test', port: 22,
    username: 'user', authType: 'privateKey', password: 'old-password',
    privateKeyPath: '~/.ssh/old-key', privateKey: 'old-inline-key', passphrase: 'old-phrase'
  });
  const identity = resolveTarget(saved.name, { identity: '~/.ssh/new-key' });
  assert.equal(identity.authType, 'privateKey');
  assert.equal(identity.password, undefined);
  assert.equal(identity.privateKey, undefined);
  assert.equal(identity.passphrase, undefined);

  const password = resolveTarget(saved.name, { password: 'new-password' });
  assert.equal(password.authType, 'password');
  assert.equal(password.password, 'new-password');
  assert.equal(password.privateKeyPath, undefined);
  assert.equal(password.privateKey, undefined);
});
