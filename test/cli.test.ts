import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { MockSSHServer } from './mock-server.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliPath = path.join(__dirname, '..', 'bin', 'sshx.js');

let mockServer: MockSSHServer;
let serverPort: number;

before(async () => {
  mockServer = new MockSSHServer({ port: 0 });
  serverPort = await mockServer.start();
});

after(async () => {
  await mockServer.stop();
});

function runCli(args: string[], env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile('node', [cliPath, ...args], { env: { ...process.env, SSH_PASSWORD: 'testpass', ...env } }, (error, stdout, stderr) => {
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

test('CLI: keygen generates Ed25519 key file', async () => {
  const tmpKey = path.join(os.tmpdir(), `sshx_test_key_${Date.now()}`);
  const res = await runCli(['keygen', '-t', 'ed25519', '-f', tmpKey, '-N', '', '-C', 'test@ci']);
  assert.equal(res.code, 0);
  assert.ok(fs.existsSync(tmpKey));
  assert.ok(fs.existsSync(`${tmpKey}.pub`));

  const pubContent = fs.readFileSync(`${tmpKey}.pub`, 'utf8');
  assert.ok(pubContent.startsWith('ssh-ed25519 '));

  fs.unlinkSync(tmpKey);
  fs.unlinkSync(`${tmpKey}.pub`);
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

  // 2. host show with --json
  const showRes = await runCli(['host', 'show', testHostName, '--json']);
  assert.equal(showRes.code, 0);
  const showData = JSON.parse(showRes.stdout);
  assert.equal(showData.name, testHostName);
  assert.equal(showData.port, serverPort);
  assert.deepEqual(showData.tags, ['ci-test', 'staging']);

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

