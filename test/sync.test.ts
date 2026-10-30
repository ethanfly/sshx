import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { encryptPayload, decryptPayload } from '../dist/sync/crypto.js';
import { SyncManager } from '../dist/sync/manager.js';
import { ConfigManager } from '../dist/core/config.js';

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
  parsed.ciphertext = parsed.ciphertext.replace(/^../, 'ff');
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
    configMgr1.addHost({
      name: 'node1-prod',
      host: '1.2.3.4',
      port: 22,
      username: 'root',
      password: 'node1-secret-password'
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

    const node2Hosts = configMgr2.getHosts();
    assert.strictEqual(node2Hosts.length, 1);
    assert.strictEqual(node2Hosts[0].name, 'node1-prod');
    assert.strictEqual(node2Hosts[0].password, 'node1-secret-password');
  } finally {
    fs.rmSync(tmpDir1, { recursive: true, force: true });
    fs.rmSync(tmpDir2, { recursive: true, force: true });
  }
});
