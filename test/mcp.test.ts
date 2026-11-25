import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MockSSHServer } from './mock-server.ts';
import { createIsolatedEnv } from './isolated-env.ts';

const isolated = createIsolatedEnv('sshx-mcp-home-');
Object.assign(process.env, isolated.env);
const { createMcpServer } = await import('../dist/skill/mcp-server.js');

let mockServer: MockSSHServer;
let serverPort: number;

before(async () => {
  mockServer = new MockSSHServer({ port: 0 });
  serverPort = await mockServer.start();
  process.env.SSH_PASSWORD = 'testpass';
});

after(async () => {
  await mockServer.stop();
  delete process.env.SSH_PASSWORD;
  isolated.cleanup();
});

test('MCP: creates server with SSH tools registered', () => {
  const mcp = createMcpServer();
  assert.ok(mcp);

  assert.deepEqual(Object.keys((mcp as any)._registeredTools).sort(), [
    'ssh_add_host', 'ssh_delete_host', 'ssh_download_file', 'ssh_exec', 'ssh_generate_key', 'ssh_get_host',
    'ssh_list_hosts', 'ssh_list_keys', 'ssh_sftp_list', 'ssh_system_info', 'ssh_test_connection',
    'ssh_update_host', 'ssh_upload_file'
  ]);
});

test('MCP: reports the installed package version', async () => {
  const { default: pkg } = await import('../package.json', { with: { type: 'json' } });
  const mcp = createMcpServer();
  assert.equal((mcp as any).server._serverInfo.version, pkg.version);
});

test('MCP: ssh_generate_key generates Ed25519 keypair', async () => {
  const mcp = createMcpServer();
  // Call internal tool handler directly
  const tools = (mcp as any)._registeredTools;
  assert.ok(tools['ssh_generate_key']);

  const handler = tools['ssh_generate_key'].handler;
  const result = await handler({ type: 'ed25519', comment: 'mcp@test' });
  assert.ok(result.content);
  assert.equal(result.content[0].type, 'text');

  const data = JSON.parse(result.content[0].text);
  assert.equal(data.keyType, 'ed25519');
  assert.ok(data.publicKeyOpenSSH.startsWith('ssh-ed25519 '));
  assert.ok(data.fingerprintSha256);
});

test('MCP: ssh_add_host and ssh_list_hosts manages host profiles', async () => {
  const mcp = createMcpServer();
  const tools = (mcp as any)._registeredTools;

  // Add host
  const addRes = await tools['ssh_add_host'].handler({
    name: 'mcp-prod',
    host: '10.0.0.5',
    port: 22,
    username: 'admin',
    tags: ['prod', 'cloud']
  });
  assert.ok(addRes.content[0].text.includes('mcp-prod'));

  // List hosts (redacted by default)
  const listRes = await tools['ssh_list_hosts'].handler({});
  const list = JSON.parse(listRes.content[0].text);
  assert.ok(Array.isArray(list));
  const found = list.find((h: any) => h.name === 'mcp-prod');
  assert.ok(found);
  assert.equal(found.host, '10.0.0.5');

  const getRes = await tools['ssh_get_host'].handler({ host: 'mcp-prod' });
  const got = JSON.parse(getRes.content[0].text);
  assert.equal(got.id, found.id);

  const updRes = await tools['ssh_update_host'].handler({
    host: 'mcp-prod',
    password: 'stored-secret',
    privateKeyPath: '~/.ssh/id_ed25519',
    notes: 'updated'
  });
  assert.ok(updRes.content[0].text.includes('updated'));
  assert.equal(updRes.content[0].text.includes('stored-secret'), false);

  const listAfterUpd = JSON.parse((await tools['ssh_list_hosts'].handler({})).content[0].text);
  const foundAfterUpd = listAfterUpd.find((h: any) => h.name === 'mcp-prod');
  assert.equal(foundAfterUpd.password, undefined);
  assert.equal(foundAfterUpd.hasPassword, true);

  const redactedGet = JSON.parse((await tools['ssh_get_host'].handler({ host: 'mcp-prod' })).content[0].text);
  assert.equal(redactedGet.password, undefined);
  assert.equal(redactedGet.hasPassword, true);
  assert.equal(redactedGet.notes, 'updated');

  const fullGet = JSON.parse((await tools['ssh_get_host'].handler({ host: 'mcp-prod', includeSecrets: true })).content[0].text);
  assert.equal(fullGet.password, 'stored-secret');
  assert.equal(fullGet.notes, 'updated');

  await tools['ssh_update_host'].handler({ host: 'mcp-prod', password: null, notes: null });
  const clearedGet = JSON.parse((await tools['ssh_get_host'].handler({ host: 'mcp-prod', includeSecrets: true })).content[0].text);
  assert.equal(clearedGet.password, undefined);
  assert.equal(clearedGet.notes, undefined);

  const delRes = await tools['ssh_delete_host'].handler({ host: 'mcp-prod' });
  assert.ok(delRes.content[0].text.includes('Deleted'));
  const missing = await tools['ssh_get_host'].handler({ host: 'mcp-prod' });
  assert.equal(missing.isError, true);
});

test('MCP: tools report failures as tool errors and validate input before connecting', async () => {
  const tools = (createMcpServer() as any)._registeredTools;
  const added = await tools['ssh_add_host'].handler({ name: 'mcp-duplicate', host: '10.0.0.6', username: 'admin' });
  assert.equal(added.isError, undefined);
  try {
    const duplicate = await tools['ssh_add_host'].handler({ name: 'mcp-duplicate', host: '10.0.0.7', username: 'admin' });
    assert.equal(duplicate.isError, true);
    assert.match(duplicate.content[0].text, /already exists/);
  } finally {
    await tools['ssh_delete_host'].handler({ host: 'mcp-duplicate' });
  }

  const missing = await tools['ssh_delete_host'].handler({ host: 'mcp-duplicate' });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /not found/);

  const upload = await tools['ssh_upload_file'].handler({ host: 'nobody@127.0.0.1:1', remotePath: '/tmp/unused' });
  assert.deepEqual(upload, {
    isError: true,
    content: [{ type: 'text', text: 'SFTP upload failed: Either content or localPath must be provided' }]
  });
});

test('MCP: ssh_exec executes command on mock SSH server', async () => {
  const mcp = createMcpServer();
  const tools = (mcp as any)._registeredTools;

  const res = await tools['ssh_exec'].handler({
    host: `testuser@127.0.0.1:${serverPort}`,
    command: 'echo hello'
  });

  assert.ok(res.content);
  assert.equal(res.isError, undefined);
  const data = JSON.parse(res.content[0].text);
  assert.equal(data.exitCode, 0);
  assert.equal(data.stdout.trim(), 'hello');
});

test('MCP: ssh_system_info queries remote server specs', async () => {
  const mcp = createMcpServer();
  const tools = (mcp as any)._registeredTools;

  const res = await tools['ssh_system_info'].handler({
    host: `testuser@127.0.0.1:${serverPort}`
  });

  assert.ok(res.content);
  assert.equal(res.isError, undefined);
  const info = JSON.parse(res.content[0].text);
  assert.equal(info.host, '127.0.0.1');
  assert.equal(info.username, 'testuser');
  assert.equal(info.hostname, 'mock-sshx-test');
  assert.ok(info.kernel);
});

test('MCP: ssh_download_file enforces maxBytes when reading content directly', async () => {
  const tools = (createMcpServer() as any)._registeredTools;
  const host = `testuser@127.0.0.1:${serverPort}`;

  const upRes = await tools['ssh_upload_file'].handler({
    host,
    remotePath: 'mcp-size-limit.txt',
    content: '0123456789'
  });
  assert.equal(upRes.isError, undefined);

  const tooLarge = await tools['ssh_download_file'].handler({
    host,
    remotePath: 'mcp-size-limit.txt',
    maxBytes: 5
  });
  assert.equal(tooLarge.isError, true);
  assert.match(tooLarge.content[0].text, /exceeds maximum read size/);

  const ok = await tools['ssh_download_file'].handler({
    host,
    remotePath: 'mcp-size-limit.txt',
    maxBytes: 20
  });
  assert.equal(ok.isError, undefined);
  assert.equal(ok.content[0].text, '0123456789');
});
