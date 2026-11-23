import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { constants as fsConstants } from 'node:fs';
import { constants as osConstants } from 'node:os';
import type { Client, ClientChannel, SFTPWrapper } from 'ssh2';
import { execCommand, SFTPClient } from '../dist/index.js';

function makeExecClient() {
  const channel = new EventEmitter();
  const stderr = new EventEmitter();
  const client = {
    exec(_command: string, _options: unknown, callback: (err: undefined, stream: ClientChannel) => void) {
      callback(undefined, Object.assign(channel, { stderr }) as unknown as ClientChannel);
    }
  } as unknown as Client;
  return { client, channel, stderr };
}

function makeSftpClient(wrapper: Partial<SFTPWrapper>): SFTPClient {
  const client = {
    sftp(callback: (err: undefined, sftp: Partial<SFTPWrapper>) => void) {
      callback(undefined, wrapper);
    }
  } as unknown as Client;
  return new SFTPClient(client);
}

test('execCommand preserves an explicit exit status and output', async () => {
  for (const exitCode of [0, 7]) {
    const { client, channel, stderr } = makeExecClient();
    const pending = execCommand(client, 'test command');
    channel.emit('data', Buffer.from('output\n'));
    stderr.emit('data', Buffer.from('diagnostic\n'));
    channel.emit('exit', exitCode);
    channel.emit('close');

    const result = await pending;
    assert.equal(result.exitCode, exitCode);
    assert.equal(result.stdout, 'output\n');
    assert.equal(result.stderr, 'diagnostic\n');
  }
});

test('execCommand returns a failure status and preserves the signal on signal termination', async () => {
  for (const [signal, exitCode] of [['SIGTERM', 128 + osConstants.signals.SIGTERM], ['SIGUNKNOWN', 1]] as const) {
    const { client, channel } = makeExecClient();
    const pending = execCommand(client, 'test command');
    channel.emit('exit', null, signal);
    channel.emit('close');

    const result = await pending;
    assert.equal(result.exitCode, exitCode);
    assert.equal(result.signal, signal);
  }
});

test('execCommand rejects a channel close without an exit status', async () => {
  const { client, channel } = makeExecClient();
  const pending = execCommand(client, 'test command');
  channel.emit('close');
  await assert.rejects(pending, /closed without a command exit status/);
});

test('SFTP rm unlinks a symlink without listing or statting its target', async () => {
  const calls: string[] = [];
  const sftp = makeSftpClient({
    lstat(remotePath, callback) {
      calls.push(`lstat ${remotePath}`);
      callback(undefined, { mode: fsConstants.S_IFLNK } as Parameters<typeof callback>[1]);
    },
    stat() { assert.fail('rm must not use stat'); },
    readdir() { assert.fail('rm must not list a symlink'); },
    rmdir() { assert.fail('rm must not remove a symlink as a directory'); },
    unlink(remotePath, callback) {
      calls.push(`unlink ${remotePath}`);
      callback();
    }
  });

  for (const remotePath of ['/entry', '/entry/']) {
    calls.length = 0;
    await sftp.rm(remotePath, true);
    assert.deepEqual(calls, ['lstat /entry', 'unlink /entry']);
  }
});

test('SFTP recursive rm checks each entry with lstat before removal', async () => {
  const calls: string[] = [];
  const sftp = makeSftpClient({
    lstat(remotePath, callback) {
      calls.push(`lstat ${remotePath}`);
      const mode = remotePath === '/tree' ? fsConstants.S_IFDIR : fsConstants.S_IFLNK;
      callback(undefined, { mode } as Parameters<typeof callback>[1]);
    },
    stat() { assert.fail('rm must not use stat'); },
    readdir(remotePath, callback) {
      assert.equal(remotePath, '/tree');
      calls.push(`readdir ${remotePath}`);
      const entry = { filename: 'entry', attrs: { mode: fsConstants.S_IFDIR } };
      callback(undefined, [entry] as Parameters<typeof callback>[1]);
    },
    unlink(remotePath, callback) {
      calls.push(`unlink ${remotePath}`);
      callback();
    },
    rmdir(remotePath, callback) {
      calls.push(`rmdir ${remotePath}`);
      callback();
    }
  });

  await sftp.rm('/tree', true);
  assert.deepEqual(calls, ['lstat /tree', 'readdir /tree', 'lstat /tree/entry', 'unlink /tree/entry', 'rmdir /tree']);
});

test('SFTP rm stops when lstat does not identify the file type', async () => {
  const sftp = makeSftpClient({
    lstat(_remotePath, callback) {
      callback(undefined, { mode: 0o755 } as Parameters<typeof callback>[1]);
    },
    readdir() { assert.fail('rm must not traverse an unknown type'); },
    rmdir() { assert.fail('rm must not remove an unknown type'); },
    unlink() { assert.fail('rm must not unlink an unknown type'); }
  });

  await assert.rejects(sftp.rm('/unknown', true), /Cannot determine remote file type/);
});
