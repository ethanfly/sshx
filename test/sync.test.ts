import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { once } from 'node:events';
import { encryptPayload, decryptPayload, encryptPayloadAsync, decryptPayloadAsync } from '../dist/sync/crypto.js';
import { SyncManager } from '../dist/sync/manager.js';
import { ConfigManager } from '../dist/core/config.js';
import { GistProvider, WebDavProvider, type SyncProvider } from '../dist/sync/provider.js';

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

test('Sync Crypto: async key derivation works with both existing and new encrypted backups', async () => {
  const original = 'sensitive host configurations';
  const legacy = encryptPayload(original, 'correct-passphrase');
  assert.equal((await decryptPayloadAsync(legacy, 'correct-passphrase')).plaintext, original);
  const asyncEncrypted = await encryptPayloadAsync(original, 'correct-passphrase', 1);
  assert.equal(decryptPayload(asyncEncrypted, 'correct-passphrase').plaintext, original);
  await assert.rejects(decryptPayloadAsync(asyncEncrypted, 'incorrect-passphrase'), /Decryption failed/);
});

test('Sync Crypto: rejects malformed metadata and invalid hex before deriving a key', async () => {
  const valid = JSON.parse(encryptPayload('hosts', 'correct-passphrase'));
  for (const changes of [{ kdf: 'untrusted' }, { salt: 'invalid' }, { iv: '00' }, { tag: '00' }, { ciphertext: '0g' }]) {
    const invalid = JSON.stringify({ ...valid, ...changes });
    assert.throws(() => decryptPayload(invalid, 'correct-passphrase'), /Invalid or unsupported encrypted payload/);
    await assert.rejects(decryptPayloadAsync(invalid, 'correct-passphrase'), /Invalid or unsupported encrypted payload/);
  }
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
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(path.join(configMgr.getConfigDir(), 'sync.json')).mode & 0o777, 0o600);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('SyncManager: reports corrupt configuration instead of treating it as unconfigured', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sshx-sync-invalid-config-'));
  try {
    const sync = new SyncManager(new ConfigManager(temporary));
    const syncFile = path.join(temporary, 'sync.json');

    for (const contents of ['{', '{"provider":"unknown"}', '{"provider":"gist"}']) {
      fs.writeFileSync(syncFile, contents);
      assert.throws(() => sync.getConfig(), /Invalid (JSON|sync configuration)/);
    }

    const previousContents = fs.readFileSync(syncFile, 'utf8');
    assert.throws(() => sync.saveConfig({ provider: 'gist' }));
    assert.equal(fs.readFileSync(syncFile, 'utf8'), previousContents);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
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
    sync.saveConfig({
      provider: 'webdav', passphrase: 'test passphrase',
      webdav: { url: 'https://mock.com', username: 'u', password: 'p' }
    });
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
    sync.saveConfig({
      provider: 'webdav', passphrase,
      webdav: { url: 'https://mock.com', username: 'u', password: 'p' }
    });
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

test('ConfigManager: full-profile overwrite does not carry credentials to a new endpoint', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sshx-overwrite-endpoint-'));
  try {
    const config = new ConfigManager(temporary);
    const original = config.addHost({
      name: 'production', host: 'old.example.test', authType: 'privateKey',
      privateKeyPath: '~/.ssh/old-key', passphrase: 'old phrase', password: 'old password',
      proxyJump: 'old-jump', proxyCommand: 'old proxy'
    });
    const replaced = config.addHost({ ...original, host: 'new.example.test' }, { overwrite: true });
    assert.strictEqual(replaced.id, original.id);
    assert.strictEqual(replaced.authType, 'password');
    for (const key of ['privateKeyPath', 'passphrase', 'password', 'proxyJump', 'proxyCommand'] as const) {
      assert.strictEqual(replaced[key], undefined);
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('ConfigManager: imported snapshot cannot restore a previous jump on another endpoint', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sshx-import-endpoint-jump-'));
  try {
    const config = new ConfigManager(temporary);
    const original = config.addHost({
      name: 'production', host: 'old.example.test', proxyJump: 'old-jump'
    });
    config.importHostsFromJson(JSON.stringify([{ ...original, host: 'new.example.test' }]));
    assert.strictEqual(config.getHost(original.id)?.proxyJump, undefined);
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

test('WebDAV provider aborts requests that exceed the configured timeout', async () => {
  const server = http.createServer((_request, _response) => {
    setTimeout(() => _response.end('late response'), 100);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const provider = new WebDavProvider({
    url: `http://127.0.0.1:${address.port}`,
    username: 'user',
    password: 'password'
  }, 20);

  try {
    await assert.rejects(provider.pull(), error =>
      error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError'));
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('Gist push explains rejected writes with GitHub status and reason', async () => {
  const originalFetch = globalThis.fetch;
  const replies: Response[] = [];
  globalThis.fetch = (async () => replies.shift() ?? new Response('unexpected request', { status: 500 })) as typeof fetch;

  try {
    const existing = new GistProvider({ token: 'test-token', gistId: 'abc123' }, 100);
    replies.push(Response.json({ message: 'Validation Failed' }, { status: 422, statusText: 'Unprocessable Entity' }));
    await assert.rejects(existing.push('snapshot'), {
      message: 'Failed to update Gist abc123 (422 Unprocessable Entity: Validation Failed)'
    });

    const fresh = new GistProvider({ token: 'test-token' }, 100);
    replies.push(Response.json([]), Response.json({ message: 'Resource not accessible' }, { status: 403, statusText: 'Forbidden' }));
    await assert.rejects(fresh.push('snapshot'), /^Error: GitHub token lacks Gist write permission \(403 Forbidden: Resource not accessible\)/);

    replies.push(Response.json([]), new Response('<html>outage</html>', { status: 502, statusText: 'Bad Gateway' }));
    await assert.rejects(fresh.push('snapshot'), { message: 'Failed to create secret Gist (502 Bad Gateway)' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Gist push does not create a new backup when Gist lookup fails', async () => {
  const originalFetch = globalThis.fetch;
  let createRequested = false;
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input).includes('/gists?per_page=100')) {
      return new Response('server error', { status: 500 });
    }
    if (String(input) === 'https://api.github.com/gists') createRequested = true;
    return new Response('unexpected request', { status: 500 });
  }) as typeof fetch;

  try {
    const provider = new GistProvider({ token: 'test-token' }, 100);
    await assert.rejects(provider.push('encrypted snapshot'), /Gist lookup failed/);
    assert.equal(createRequested, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Gist push finds an existing backup on later pages instead of creating a duplicate', async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    if (url === 'https://api.github.com/gists?per_page=100') {
      return new Response('[]', {
        headers: { link: '<https://api.github.com/gists?per_page=100&page=2>; rel="next"' }
      });
    }
    if (url === 'https://api.github.com/gists?per_page=100&page=2') {
      return Response.json([{ id: 'existing-backup', files: { 'sshx-hosts.enc': {} } }]);
    }
    if (url === 'https://api.github.com/gists/existing-backup') return Response.json({ id: 'existing-backup' });
    return new Response('unexpected request', { status: 500 });
  }) as typeof fetch;

  try {
    const provider = new GistProvider({ token: 'test-token' });
    assert.equal((await provider.push('encrypted snapshot')).remoteId, 'existing-backup');
    assert.deepEqual(requests, [
      'https://api.github.com/gists?per_page=100',
      'https://api.github.com/gists?per_page=100&page=2',
      'https://api.github.com/gists/existing-backup'
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Gist pull refuses a truncated encrypted backup', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => Response.json({
      files: { 'sshx-hosts.enc': { content: 'partial ciphertext', truncated: true } }
    })) as typeof fetch;

    const provider = new GistProvider({ token: 'test-token', gistId: 'existing-backup' });
    await assert.rejects(provider.pull(), /backup is truncated/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('WebDAV push refuses to continue after a network failure when creating a directory', async () => {
  const originalFetch = globalThis.fetch;
  let putRequested = false;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'MKCOL') throw new Error('WebDAV offline');
    if (init?.method === 'PUT') putRequested = true;
    return new Response('unexpected request', { status: 500 });
  }) as typeof fetch;

  try {
    const provider = new WebDavProvider({ url: 'https://dav.example.test/sshx', username: 'u', password: 'p' });
    await assert.rejects(provider.push('backup'), /WebDAV offline/);
    assert.equal(putRequested, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('WebDAV push rejects directory setup failures without attempting an upload', async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  try {
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      requests.push(init?.method ?? 'GET');
      return new Response(null, { status: 403, statusText: 'Forbidden' });
    }) as typeof fetch;

    const provider = new WebDavProvider({ url: 'https://dav.example.test/sshx', username: 'u', password: 'p' });
    await assert.rejects(provider.push('backup'), /directory setup failed with status 403/);
    assert.deepEqual(requests, ['MKCOL']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('WebDAV push accepts an existing directory', async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  try {
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      requests.push(init?.method ?? 'GET');
      return new Response(null, { status: init?.method === 'MKCOL' ? 405 : 204 });
    }) as typeof fetch;

    const provider = new WebDavProvider({ url: 'https://dav.example.test/sshx', username: 'u', password: 'p' });
    await provider.push('backup');
    assert.deepEqual(requests, ['MKCOL', 'PUT']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('SyncManager: falls back to SSHX_SYNC_PASSPHRASE when passphrase is not stored', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sshx-sync-env-pass-'));
  const previous = process.env.SSHX_SYNC_PASSPHRASE;
  try {
    const config = new ConfigManager(temporary);
    config.addHost({ name: 'env-host', host: '10.10.0.1' });
    const sync = new SyncManager(config);
    sync.saveConfig({
      provider: 'webdav',
      savePassphrase: false,
      webdav: { url: 'https://mock.test', username: 'u', password: 'p' }
    });

    let stored = '';
    sync.getProvider = () => ({
      name: 'memory',
      async test() { return { ok: true, message: 'ok' }; },
      async pull() { return stored; },
      async push(blob) { stored = blob; return {}; }
    });

    delete process.env.SSHX_SYNC_PASSPHRASE;
    await assert.rejects(sync.push(), /Passphrase is required/);

    process.env.SSHX_SYNC_PASSPHRASE = 'env-master-passphrase';
    const pushed = await sync.push();
    assert.equal(pushed.count, 1);

    config.saveHosts([]);
    const pulled = await sync.pull();
    assert.equal(pulled.imported, 1);
    assert.equal(config.getHost('env-host')?.host, '10.10.0.1');
  } finally {
    if (previous === undefined) delete process.env.SSHX_SYNC_PASSPHRASE;
    else process.env.SSHX_SYNC_PASSPHRASE = previous;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
