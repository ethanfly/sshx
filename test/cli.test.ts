import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { MockSSHServer } from './mock-server.ts';
import { createIsolatedEnv } from './isolated-env.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliPath = path.join(__dirname, '..', 'bin', 'sshx.js');
const isolated = createIsolatedEnv('sshx-cli-home-');

let mockServer: MockSSHServer;
let serverPort: number;

before(async () => {
  mockServer = new MockSSHServer({ port: 0 });
  serverPort = await mockServer.start();
});

after(async () => {
  await mockServer.stop();
  isolated.cleanup();
});

function runCli(args: string[], env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const childEnv = { ...process.env, ...isolated.env, SSH_PASSWORD: 'testpass', ...env };
    execFile('node', [cliPath, ...args], { env: childEnv }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        code: error ? (error.code as number || 1) : 0
      });
    });
  });
}

test('CLI: --help prints available subcommands', async () => {
  const res = await runCli(['--help']);
  assert.equal(res.code, 0);
  assert.ok(res.stdout.includes('Usage: sshx'));
  assert.ok(res.stdout.includes('connect'));
  assert.ok(res.stdout.includes('exec'));
  assert.ok(res.stdout.includes('sftp'));
  assert.ok(res.stdout.includes('tunnel'));
  assert.ok(res.stdout.includes('host'));
  assert.ok(res.stdout.includes('keygen'));
  assert.ok(res.stdout.includes('tui'));
  assert.ok(!res.stdout.includes('gui'));
  assert.ok(res.stdout.includes('mcp'));
  assert.ok(res.stdout.includes('skill'));
});

test('CLI: --version reports the installed package version', async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const res = await runCli(['--version']);
  assert.equal(res.code, 0);
  assert.equal(res.stdout.trim(), pkg.version);
});

test('CLI: keygen generates an Ed25519 key and refuses to overwrite it', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshx-cli-key-'));
  const keyPath = path.join(tempDir, 'id_ed25519');
  try {
    const args = ['keygen', '-t', 'ed25519', '-f', keyPath, '-N', '', '-C', 'test-key'];
    const result = await runCli(args);
    assert.equal(result.code, 0);
    const privateKey = fs.readFileSync(keyPath, 'utf8');
    const publicKey = fs.readFileSync(`${keyPath}.pub`, 'utf8');
    assert.match(privateKey, /BEGIN OPENSSH PRIVATE KEY/);
    assert.match(publicKey, /^ssh-ed25519 /);

    const collision = await runCli(args);
    assert.equal(collision.code, 1);
    assert.match(collision.stderr, /Key file already exists/);
    assert.equal(fs.readFileSync(keyPath, 'utf8'), privateKey);
    assert.equal(fs.readFileSync(`${keyPath}.pub`, 'utf8'), publicKey);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('CLI: exec command against mock SSH server with --json', async () => {
  // Using direct target syntax: username@host -p port --password
  const res = await runCli([
    'exec',
    `testuser@127.0.0.1`,
    '-p',
    String(serverPort),
    '--password',
    'testpass',
    'echo hello',
    '--json'
  ]);

  if (res.code !== 0) {
    console.error('DEBUG EXEC FAIL:', res);
  }
  assert.equal(res.code, 0);
  const data = JSON.parse(res.stdout);
  assert.equal(data.exitCode, 0);
  assert.equal(data.stdout.trim(), 'hello');
});

test('CLI: exec rejects invalid limits and preserves equals signs in environment values', async () => {
  const base = ['exec', 'testuser@127.0.0.1', '-p', String(serverPort), '--password', 'testpass', 'echo hello'];
  for (const args of [
    ['--timeout', '0'],
    ['--timeout', 'not-a-number'],
    ['--timeout', '2147484'],
    ['--max-output-bytes', '-1'],
    ['--env', 'MISSING_EQUALS']
  ]) {
    const result = await runCli([...base, ...args]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /--timeout|--max-output-bytes|KEY=VAL/);
  }

  const result = await runCli([
    'exec', 'testuser@127.0.0.1', '-p', String(serverPort), '--password', 'testpass',
    'printenv TEST_EXEC_VALUE', '--env', 'TEST_EXEC_VALUE=one=two', '--max-output-bytes', '100'
  ]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'one=two');

  const limited = await runCli([...base, '--max-output-bytes', '1']);
  assert.equal(limited.code, 1);
  assert.match(limited.stderr, /output exceeded 1 bytes/);
});

test('CLI: host list --json returns valid JSON array', async () => {
  const res = await runCli(['host', 'list', '--json']);
  assert.equal(res.code, 0);
  const hosts = JSON.parse(res.stdout);
  assert.ok(Array.isArray(hosts));
});

test('CLI: skill inspect returns system specs', async () => {
  const res = await runCli([
    'skill',
    'inspect',
    `testuser@127.0.0.1:${serverPort}`
  ]);

  assert.equal(res.code, 0);
  const info = JSON.parse(res.stdout);
  assert.equal(info.host, '127.0.0.1');
  assert.equal(info.username, 'testuser');
  assert.ok(info.kernel);
});

test('CLI: host add, show, edit, list, export, import, and remove operations', async () => {
  const testHostName = `cli-test-${Date.now()}`;

  // 1. host add with flags
  const addRes = await runCli([
    'host',
    'add',
    '-n',
    testHostName,
    '-H',
    '127.0.0.1',
    '-p',
    String(serverPort),
    '-u',
    'testuser',
    '--password',
    'testpass',
    '-t',
    'ci-test',
    'staging',
    '--notes',
    'Test server created by automated test'
  ]);
  assert.equal(addRes.code, 0);
  assert.ok(addRes.stdout.includes(testHostName));

  // 2. host show with --json (redacted by default, full with --show-secrets)
  const showRes = await runCli(['host', 'show', testHostName, '--json']);
  assert.equal(showRes.code, 0);
  const showData = JSON.parse(showRes.stdout);
  assert.equal(showData.name, testHostName);
  assert.equal(showData.port, serverPort);
  assert.deepEqual(showData.tags, ['ci-test', 'staging']);
  assert.equal(showData.password, undefined);
  assert.equal(showData.hasPassword, true);

  const showSecretsRes = await runCli(['host', 'show', testHostName, '--json', '--show-secrets']);
  assert.equal(showSecretsRes.code, 0);
  assert.equal(JSON.parse(showSecretsRes.stdout).password, 'testpass');

  const listRedactedRes = await runCli(['host', 'list', '--search', testHostName, '--json']);
  assert.equal(listRedactedRes.code, 0);
  const [listRedactedItem] = JSON.parse(listRedactedRes.stdout);
  assert.equal(listRedactedItem.password, undefined);
  assert.equal(listRedactedItem.hasPassword, true);

  // 3. direct connection using configured host name
  const execDirectRes = await runCli([
    'exec',
    testHostName,
    'echo hello',
    '--json'
  ]);
  assert.equal(execDirectRes.code, 0);
  const execData = JSON.parse(execDirectRes.stdout);
  assert.equal(execData.exitCode, 0);
  assert.equal(execData.stdout.trim(), 'hello');

  // 4. host edit with flags
  const editRes = await runCli([
    'host',
    'edit',
    testHostName,
    '-u',
    'testuser-updated',
    '--notes',
    'Updated notes'
  ]);
  assert.equal(editRes.code, 0);
  assert.ok(editRes.stdout.includes('Successfully updated'));

  const verifyEditRes = await runCli(['host', 'show', testHostName, '--json']);
  const verifyData = JSON.parse(verifyEditRes.stdout);
  assert.equal(verifyData.username, 'testuser-updated');
  assert.equal(verifyData.notes, 'Updated notes');

  const clearNotesRes = await runCli(['host', 'edit', testHostName, '--notes', '']);
  assert.equal(clearNotesRes.code, 0);
  const verifyClearRes = await runCli(['host', 'show', testHostName, '--json']);
  assert.equal(JSON.parse(verifyClearRes.stdout).notes, undefined);

  // 5. host list with --search and top-level hosts shortcut
  const searchRes = await runCli(['host', 'list', '--search', testHostName, '--json']);
  assert.equal(searchRes.code, 0);
  const searchList = JSON.parse(searchRes.stdout);
  assert.equal(searchList.length, 1);
  assert.equal(searchList[0].name, testHostName);

  const shortcutRes = await runCli(['hosts', '--tag', 'ci-test', '--json']);
  assert.equal(shortcutRes.code, 0);
  const shortcutList = JSON.parse(shortcutRes.stdout);
  assert.ok(shortcutList.some((h: any) => h.name === testHostName));

  // 6. host export and import
  const exportPath = path.join(os.tmpdir(), `sshx_export_${Date.now()}.json`);
  const exportRes = await runCli(['host', 'export', exportPath]);
  assert.equal(exportRes.code, 0);
  assert.ok(fs.existsSync(exportPath));

  const importRes = await runCli(['host', 'import', exportPath]);
  assert.equal(importRes.code, 0);
  assert.ok(importRes.stdout.includes('Successfully imported hosts'));
  fs.unlinkSync(exportPath);

  // 7. host remove with --force
  const removeRes = await runCli(['host', 'remove', testHostName, '--force']);
  assert.equal(removeRes.code, 0);
  assert.ok(removeRes.stdout.includes('Removed host profile'));

  // Verify removed
  const verifyRemoveRes = await runCli(['host', 'show', testHostName, '--json']);
  assert.equal(verifyRemoveRes.code, 1);
});

test('CLI: host aliases (new, ls, info, rm, delete) and error suggestions', async () => {
  const aliasHost = `alias-test-${Date.now()}`;

  // 1. host new alias
  const addRes = await runCli([
    'host',
    'new',
    '-n',
    aliasHost,
    '-H',
    '127.0.0.1',
    '-p',
    String(serverPort),
    '-u',
    'testuser',
    '-y'
  ]);
  assert.equal(addRes.code, 0);

  // 2. host ls alias
  const lsRes = await runCli(['host', 'ls', '--json']);
  assert.equal(lsRes.code, 0);
  const list = JSON.parse(lsRes.stdout);
  assert.ok(list.some((h: any) => h.name.toLowerCase() === aliasHost.toLowerCase()));

  // 3. host info alias with case-insensitivity
  const infoRes = await runCli(['host', 'info', aliasHost.toUpperCase(), '--json']);
  assert.equal(infoRes.code, 0);
  const info = JSON.parse(infoRes.stdout);
  assert.equal(info.name, aliasHost);

  // 4. Suggestion when misspelled
  const typoRes = await runCli(['host', 'show', `${aliasHost}-typo`]);
  assert.equal(typoRes.code, 1);
  assert.ok(typoRes.stderr.includes('Did you mean one of these?'));
  assert.ok(typoRes.stderr.includes(aliasHost));

  // 5. host delete alias with -y
  const delRes = await runCli(['host', 'delete', aliasHost, '-y']);
  assert.equal(delRes.code, 0);
  assert.ok(delRes.stdout.includes('Removed host profile'));
});

test('CLI: host add requires explicit overwrite and honors authentication aliases', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sshx-cli-overwrite-'));
  const env = { SSHX_CONFIG_DIR: temporary };
  try {
    const add = await runCli([
      'host', 'add', '--name', 'Primary', '--host', '192.0.2.1', '--username', 'alice',
      '--port', '2222', '--auth', 'key', '--key', '~/.ssh/test-key', '--jump', 'bastion',
      '--notes', 'preserved notes', '--tags', 'test'
    ], env);
    assert.equal(add.code, 0, add.stderr);
    const hostsFile = path.join(temporary, 'hosts.json');
    const before = fs.readFileSync(hostsFile, 'utf8');
    const [initial] = JSON.parse(before);
    assert.equal(initial.authType, 'privateKey');
    assert.equal(initial.privateKeyPath, '~/.ssh/test-key');
    assert.equal(initial.proxyJump, 'bastion');

    const duplicate = await runCli(['host', 'add', '--name', 'PRIMARY', '--host', '192.0.2.2', '--yes'], env);
    assert.equal(duplicate.code, 1);
    assert.match(duplicate.stderr, /already exists.*--force/);
    assert.equal(fs.readFileSync(hostsFile, 'utf8'), before);

    const forced = await runCli(['host', 'add', '--name', 'PRIMARY', '--host', '192.0.2.1', '--force'], env);
    assert.equal(forced.code, 0, forced.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(hostsFile, 'utf8')), [{ ...initial, name: 'PRIMARY' }]);

    const replacement = await runCli(['host', 'add', '--name', 'PRIMARY', '--host', '192.0.2.2', '--force'], env);
    assert.equal(replacement.code, 0, replacement.stderr);
    const [replaced] = JSON.parse(fs.readFileSync(hostsFile, 'utf8'));
    assert.equal(replaced.id, initial.id);
    assert.equal(replaced.host, '192.0.2.2');
    assert.equal(replaced.notes, initial.notes);
    assert.deepEqual(replaced.tags, initial.tags);
    assert.equal(replaced.authType, 'password');
    assert.equal(replaced.privateKeyPath, undefined);
    assert.equal(replaced.proxyJump, undefined);

    const renamed = await runCli(['host', 'edit', 'primary', '--auth-type', 'key', '--key', '~/.ssh/other-key'], env);
    assert.equal(renamed.code, 0, renamed.stderr);
    const [edited] = JSON.parse(fs.readFileSync(hostsFile, 'utf8'));
    assert.equal(edited.id, initial.id);
    assert.equal(edited.authType, 'privateKey');
    assert.equal(edited.privateKeyPath, '~/.ssh/other-key');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('CLI: running bare sshx defaults to TUI', async () => {
  // In a simulated terminal environment, bare sshx launches TUI
  const res = await new Promise<{ launched: boolean; code: number }>((resolve) => {
    const proc = execFile('node', [cliPath], {
      env: { ...process.env, TERM: 'xterm-256color' }
    });

    let buffer = '';
    proc.stdout?.on('data', (data) => {
      buffer += data.toString();
      // Look for alternate screen buffer sequence or TUI title
      if (buffer.includes('\x1b[?1049h') || buffer.includes('sshx') || buffer.includes('Search')) {
        proc.kill('SIGINT');
        resolve({ launched: true, code: 0 });
      }
    });

    proc.on('close', (code) => {
      resolve({
        launched: buffer.includes('\x1b[?1049h') || buffer.includes('sshx'),
        code: code || 0
      });
    });

    // Send Ctrl-C after a short delay if not captured
    setTimeout(() => {
      try { proc.kill('SIGINT'); } catch { /* ignore */ }
    }, 500);
  });

  assert.ok(res.launched, 'Bare sshx command should launch TUI by default');
});

test('CLI: sync setup with flags completes non-interactively and honors --no-save-passphrase', async () => {
  const tempCfg = fs.mkdtempSync(path.join(os.tmpdir(), 'sshx-cli-sync-setup-'));
  try {
    const res = await runCli([
      'sync', 'setup',
      '--provider', 'gist',
      '--token', 'ghp_non_interactive_test_token',
      '--passphrase', 'master-pass',
      '--no-save-passphrase'
    ], { SSHX_CONFIG_DIR: tempCfg });
    assert.equal(res.code, 0, res.stderr);
    const saved = JSON.parse(fs.readFileSync(path.join(tempCfg, 'sync.json'), 'utf8'));
    assert.equal(saved.provider, 'gist');
    assert.equal(saved.gist.token, 'ghp_non_interactive_test_token');
    assert.equal(saved.savePassphrase, false);
    assert.equal(saved.passphrase, undefined);
  } finally {
    fs.rmSync(tempCfg, { recursive: true, force: true });
  }
});

test('CLI: sftp put/get auto-append basename when destination is an existing directory', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshx-cli-sftp-dir-'));
  const localSrc = path.join(tempDir, 'sample.txt');
  const localOutDir = path.join(tempDir, 'out');
  fs.writeFileSync(localSrc, 'dir-transfer-ok');
  fs.mkdirSync(localOutDir);
  fs.mkdirSync(path.join(mockServer.tempDir, 'inbox'), { recursive: true });
  try {
    const putRes = await runCli([
      'sftp', 'put',
      `testuser@127.0.0.1:${serverPort}`,
      localSrc,
      'inbox'
    ]);
    assert.equal(putRes.code, 0, putRes.stderr);
    assert.equal(fs.readFileSync(path.join(mockServer.tempDir, 'inbox', 'sample.txt'), 'utf8'), 'dir-transfer-ok');

    const getRes = await runCli([
      'sftp', 'get',
      `testuser@127.0.0.1:${serverPort}`,
      'inbox/sample.txt',
      localOutDir
    ]);
    assert.equal(getRes.code, 0, getRes.stderr);
    assert.equal(fs.readFileSync(path.join(localOutDir, 'sample.txt'), 'utf8'), 'dir-transfer-ok');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

