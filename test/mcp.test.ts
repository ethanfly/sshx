import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpServer } from '../dist/skill/mcp-server.js';
import { MockSSHServer } from './mock-server.ts';

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
});

test('MCP: creates server with SSH tools registered', () => {
  const mcp = createMcpServer();
  assert.ok(mcp);

  // Check registered tools via server instance
  const server = (mcp as any).server;
  assert.ok(server);
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

  // List hosts
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

  const after = JSON.parse((await tools['ssh_get_host'].handler({ host: 'mcp-prod' })).content[0].text);
  assert.equal(after.password, 'stored-secret');
  assert.equal(after.notes, 'updated');

  const delRes = await tools['ssh_delete_host'].handler({ host: 'mcp-prod' });
  assert.ok(delRes.content[0].text.includes('Deleted'));
  const missing = await tools['ssh_get_host'].handler({ host: 'mcp-prod' });
  assert.equal(missing.isError, true);
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
  assert.ok(info.kernel);
});
