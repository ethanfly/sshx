import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { encryptPayload, decryptPayload } from '../dist/sync/crypto.js';
import { SyncManager } from '../dist/sync/manager.js';
import { ConfigManager } from '../dist/core/config.js';
import type { SyncProvider } from '../dist/sync/provider.js';

test('Sync Crypto: encrypts and decrypts payload correctly with AES-256-GCM', () => {
  const plaintext = JSON.stringify([{ name: 'prod', host: '10.0.0.1', password: 'my-secret-password' }]);
  const passphrase = 'MySuperMasterPassword123!';

  const encrypted = encryptPayload(plaintext, passphrase, 1);
  assert.ok(encrypted.includes('"algorithm": "aes-256-gcm"'));
  assert.ok(!encrypted.includes('my-secret-password'), 'Ciphertext must not contain plaintext secrets');

  const { plaintext: decrypted, payload } = decryptPayload(encrypted, passphrase);
  assert.strictEqual(decrypted, plaintext);
  assert.strictEqual(payload.version, 1);
  assert.strictEqual(payload.itemCount, 1);
});

test('Sync Crypto: fails decryption with incorrect passphrase', () => {
  const plaintext = 'sensitive host configurations';
  const encrypted = encryptPayload(plaintext, 'correct-passphrase');

  assert.throws(() => {
    decryptPayload(encrypted, 'wrong-passphrase');
  }, /Decryption failed/);
});

test('Sync Crypto: fails decryption on corrupted or tampered ciphertext', () => {
  const plaintext = 'sensitive host configurations';
  const encrypted = encryptPayload(plaintext, 'my-passphrase');
  const parsed = JSON.parse(encrypted);
  // Tamper ciphertext
  const ciphertext = Buffer.from(parsed.ciphertext, 'hex');
  ciphertext[0] ^= 1;
  parsed.ciphertext = ciphertext.toString('hex');
  const tampered = JSON.stringify(parsed);

  assert.throws(() => {
    decryptPayload(tampered, 'my-passphrase');
  }, /Decryption failed/);
});

test('SyncManager: saves and loads sync configuration', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshx-sync-test-'));
  try {
    const configMgr = new ConfigManager(tmpDir);
    const syncMgr = new SyncManager(configMgr);

    assert.strictEqual(syncMgr.getConfig(), null);

    syncMgr.saveConfig({
      provider: 'webdav',
      passphrase: 'test-passphrase',
      savePassphrase: true,
      webdav: {
        url: 'https://dav.example.com/sshx/',
        username: 'alice',
        password: 'password123'
      }
    });

    const loaded = syncMgr.getConfig();
    assert.ok(loaded);
    assert.strictEqual(loaded.provider, 'webdav');
    assert.strictEqual(loaded.webdav?.username, 'alice');
    assert.strictEqual(loaded.passphrase, 'test-passphrase');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('SyncManager: end-to-end push and pull using mock provider', async () => {
  const tmpDir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'sshx-sync-node1-'));
  const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sshx-sync-node2-'));

  try {
    // Node 1: add host profile
    const configMgr1 = new ConfigManager(tmpDir1);
    const source = configMgr1.addHost({
      name: 'node1-prod',
      host: '1.2.3.4',
      port: 2222,
      username: 'root',
      authType: 'privateKey',
      password: 'node1-secret-password',
      privateKeyPath: '~/.ssh/test-identity',
      privateKey: 'test private key fixture',
      passphrase: 'test key passphrase',
      proxyJump: 'jump-id',
      proxyCommand: 'test proxy command',
      keepaliveInterval: 30_000,
      keepaliveCountMax: 6,
      readyTimeout: 45_000,
      tags: ['prod', 'devops'],
      group: 'test group',
      environment: { TZ: 'UTC' },
      lastConnected: '2025-01-01T00:00:00.000Z',
      favorite: true,
      notes: 'test notes'
    });

    let remoteStorage: string = '';

    // Mock Provider that mimics cloud storage
    class MemoryProvider implements SyncProvider {
      public name = 'memory';
      async test() { return { ok: true, message: 'ok' }; }
      async pull() { return remoteStorage; }
      async push(blob: string) { remoteStorage = blob; return { remoteId: 'mem_1' }; }
    }

    const memoryProvider = new MemoryProvider();

    const syncMgr1 = new SyncManager(configMgr1);
    syncMgr1.saveConfig({
      provider: 'webdav',
      passphrase: 'shared-passphrase',
      webdav: { url: 'https://mock.com', username: 'u', password: 'p' }
    });
    // Override provider
    syncMgr1.getProvider = () => memoryProvider;

    const pushRes = await syncMgr1.push();
    assert.strictEqual(pushRes.ok, true);
    assert.strictEqual(pushRes.count, 1);
    assert.ok(remoteStorage.length > 0);
    assert.ok(!remoteStorage.includes('node1-secret-password'), 'Cloud blob must be encrypted');

    // Node 2: pull from cloud
    const configMgr2 = new ConfigManager(tmpDir2);
    assert.strictEqual(configMgr2.getHosts().length, 0);

    const syncMgr2 = new SyncManager(configMgr2);
    syncMgr2.saveConfig({
      provider: 'webdav',
      passphrase: 'shared-passphrase',
      webdav: { url: 'https://mock.com', username: 'u', password: 'p' }
    });
    syncMgr2.getProvider = () => memoryProvider;

    const pullRes = await syncMgr2.pull();
    assert.strictEqual(pullRes.ok, true);
    assert.strictEqual(pullRes.imported, 1);

    assert.deepStrictEqual(configMgr2.getHosts(), [source]);
  } finally {
    fs.rmSync(tmpDir1, { recursive: true, force: true });
    fs.rmSync(tmpDir2, { recursive: true, force: true });
  }
});

test('SyncManager: rejects corrupt or unreadable host configuration without uploading', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sshx-sync-corrupt-'));
  try {
    const config = new ConfigManager(temporary);
    const sync = new SyncManager(config);
    sync.saveConfig({ provider: 'webdav', passphrase: 'test passphrase' });
    const hostsFile = config.getHostsFilePath();
    let providerRequested = false;
    sync.getProvider = () => {
      providerRequested = true;
      throw new Error('Provider must not be touched');
    };

    assert.deepStrictEqual(config.getHosts(), []);
    await assert.rejects(sync.push(), /No saved hosts file/);

    for (const contents of ['{"incomplete":', '{}', '[{"name":"broken"}]']) {
      fs.writeFileSync(hostsFile, contents);
      await assert.rejects(sync.push(), /Invalid (JSON|host profiles)/);
      assert.strictEqual(fs.readFileSync(hostsFile, 'utf8'), contents);
    }
    fs.unlinkSync(hostsFile);
    fs.mkdirSync(hostsFile);
    await assert.rejects(sync.push(), /Could not read hosts file|Invalid JSON/);
    assert.strictEqual(providerRequested, false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('SyncManager: refuses ambiguous legacy profiles but can upload an explicitly empty file', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sshx-sync-empty-'));
  try {
    const config = new ConfigManager(temporary);
    const sync = new SyncManager(config);
    const passphrase = 'test passphrase';
    sync.saveConfig({ provider: 'webdav', passphrase });
    let uploaded: string | undefined;
    sync.getProvider = () => ({
      name: 'memory',
      async test() { return { ok: true, message: 'ok' }; },
      async pull() { return uploaded ?? ''; },
      async push(blob) { uploaded = blob; return {}; }
    });

    const original = config.addHost({ name: 'sample', host: 'sample.example.test' });
    config.saveHosts([original, { ...original, id: 'legacy', name: 'Sample' }]);
    assert.strictEqual(config.getHosts().length, 2);
    await assert.rejects(sync.push(), /duplicate names or IDs/);
    assert.strictEqual(uploaded, undefined);
    config.updateHost('legacy', { name: 'another' });
    assert.strictEqual(config.getHost('another')?.id, 'legacy');

    config.saveHosts([]);
    assert.strictEqual((await sync.push()).count, 0);
    assert.ok(uploaded !== undefined);
    assert.strictEqual(decryptPayload(uploaded, passphrase).plaintext, '[]');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('ConfigManager: merging snapshots preserves local IDs and both sets of jump references', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sshx-sync-merge-'));
  try {
    const config = new ConfigManager(temporary);
    config.addHost({
      id: 'local-jump', name: 'jump', host: 'old.example.test', notes: 'keep this',
      authType: 'privateKey', password: 'old password', privateKey: 'old key', privateKeyPath: '~/.ssh/old-key',
      passphrase: 'old phrase', proxyJump: 'old-proxy-id', proxyCommand: 'old proxy command'
    });
    config.addHost({ id: 'local-target', name: 'local', host: 'local.example.test', proxyJump: 'local-jump' });

    const incoming = JSON.stringify([
      { id: 'remote-target', name: 'remote', host: 'remote.example.test', proxyJump: 'remote-jump' },
      { id: 'remote-jump', name: 'Jump', host: 'new.example.test' }
    ]);
    assert.deepStrictEqual(config.importHostsFromJson(incoming), { imported: 1, updated: 1, total: 3 });
    const jump = config.getHost('jump');
    assert.strictEqual(jump?.id, 'local-jump');
    assert.strictEqual(jump?.host, 'new.example.test');
    assert.strictEqual(jump?.notes, 'keep this');
    assert.strictEqual(jump?.authType, 'password');
    assert.strictEqual(jump?.privateKey, undefined);
    assert.strictEqual(jump?.privateKeyPath, undefined);
    assert.strictEqual(jump?.passphrase, undefined);
    assert.strictEqual(jump?.password, undefined);
    assert.strictEqual(jump?.proxyCommand, undefined);
    assert.strictEqual(jump?.proxyJump, undefined);
    assert.strictEqual(config.getHost('local-target')?.proxyJump, 'local-jump');
    assert.strictEqual(config.getHost('remote-target')?.proxyJump, 'local-jump');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('ConfigManager: invalid overwrite import does not modify the saved hosts', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sshx-sync-invalid-import-'));
  try {
    const config = new ConfigManager(temporary);
    const original = config.addHost({ name: 'good', host: 'good.example.test' });
    const before = fs.readFileSync(config.getHostsFilePath(), 'utf8');
    assert.throws(() => config.importHostsFromJson('[{"name":"broken"}]', 'overwrite'));
    assert.strictEqual(fs.readFileSync(config.getHostsFilePath(), 'utf8'), before);
    assert.deepStrictEqual(config.getHosts(), [original]);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('ConfigManager: replacement and merge do not reuse old credentials after a private key change', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sshx-sync-key-replace-'));
  try {
    const config = new ConfigManager(temporary);
    const endpoint = { name: 'keyed', host: 'keyed.example.test' };
    const original = config.addHost({
      ...endpoint,
      privateKey: 'original inline key',
      privateKeyPath: '~/.ssh/original-key',
      passphrase: 'original key passphrase'
    });
    const unchanged = config.addHost({ ...endpoint, privateKeyPath: original.privateKeyPath }, { overwrite: true });
    assert.strictEqual(unchanged.privateKey, original.privateKey);
    assert.strictEqual(unchanged.passphrase, original.passphrase);

    const replacement = config.addHost({ ...endpoint, privateKeyPath: '~/.ssh/replacement-key' }, { overwrite: true });
    assert.strictEqual(replacement.id, original.id);
    assert.strictEqual(replacement.privateKeyPath, '~/.ssh/replacement-key');
    assert.strictEqual(replacement.privateKey, undefined);
    assert.strictEqual(replacement.passphrase, undefined);

    config.importHostsFromJson(JSON.stringify([{ ...endpoint, privateKey: 'incoming key', passphrase: 'incoming phrase' }]));
    assert.strictEqual(config.getHost(original.id)?.passphrase, 'incoming phrase');
    config.importHostsFromJson(JSON.stringify([{ ...endpoint, privateKey: 'rotated inline key', privateKeyPath: '~/.ssh/rotated-key' }]));
    const rotated = config.getHost(original.id);
    assert.strictEqual(rotated?.privateKey, 'rotated inline key');
    assert.strictEqual(rotated?.privateKeyPath, '~/.ssh/rotated-key');
    assert.strictEqual(rotated?.passphrase, undefined);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
