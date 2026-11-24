import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { constants as fsConstants } from 'node:fs';
import { constants as osConstants } from 'node:os';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
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
  const emitter = Object.assign(new EventEmitter(), wrapper);
  const client = {
    sftp(callback: (err: undefined, sftp: Partial<SFTPWrapper>) => void) {
      callback(undefined, emitter);
    }
  } as unknown as Client;
  return new SFTPClient(client);
}

test('SFTP shares a pending wrapper request and retries after failure', async () => {
  let requests = 0;
  let finish: ((err: Error | undefined, wrapper: SFTPWrapper) => void) | undefined;
  const wrapper = new EventEmitter() as SFTPWrapper;
  const client = new SFTPClient({
    sftp(callback: typeof finish) {
      requests++;
      finish = callback;
    }
  } as unknown as Client);

  const first = client.getWrapper();
  const second = client.getWrapper();
  assert.equal(requests, 1);
  finish!(new Error('channel refused'), wrapper);
  await assert.rejects(first, /channel refused/);
  await assert.rejects(second, /channel refused/);

  const retry = client.getWrapper();
  assert.equal(requests, 2);
  finish!(undefined, wrapper);
  assert.equal(await retry, wrapper);
  wrapper.emit('close');
  const reopened = client.getWrapper();
  assert.equal(requests, 3);
  finish!(undefined, wrapper);
  await reopened;
});

test('SFTP exists propagates permission errors and mkdir never hides a failed creation', async () => {
  const missing = Object.assign(new Error('missing'), { code: 2 });
  const denied = Object.assign(new Error('permission denied'), { code: 3 });
  let status: Error = denied;
  let mkdirCalls = 0;
  const sftp = makeSftpClient({
    stat(_remotePath, callback) {
      callback(status, undefined as never);
    },
    mkdir(_remotePath, callback) {
      mkdirCalls++;
      callback(Object.assign(new Error('failed'), { code: 4 }));
    }
  });

  await assert.rejects(sftp.exists('/private'), /permission denied/);
  await assert.rejects(sftp.mkdir('/private'), /permission denied/);
  assert.equal(mkdirCalls, 0);

  status = missing;
  assert.equal(await sftp.exists('/missing'), false);
  await assert.rejects(sftp.mkdir('/missing'), /failed/);
  assert.equal(mkdirCalls, 1);
});

test('SFTP download preserves an existing file and removes incomplete temporary data', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sshx-partial-download-'));
  const destination = path.join(directory, 'target.txt');
  fs.writeFileSync(destination, 'original');
  try {
    const sftp = makeSftpClient({
      stat(_remotePath, callback) {
        callback(undefined, { mode: fsConstants.S_IFREG, size: 100 } as Parameters<typeof callback>[1]);
      },
      createReadStream() {
        return Readable.from((async function* () {
          yield Buffer.from('partial');
          throw new Error('remote read failed');
        })()) as ReturnType<SFTPWrapper['createReadStream']>;
      }
    });
    await assert.rejects(sftp.downloadFile('/remote', destination), /remote read failed/);
    assert.equal(fs.readFileSync(destination, 'utf8'), 'original');
    assert.deepEqual(fs.readdirSync(directory), ['target.txt']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('SFTP upload rejects write errors rather than reporting a successful transfer', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sshx-upload-error-'));
  const source = path.join(directory, 'source.txt');
  fs.writeFileSync(source, 'some data');
  try {
    const sftp = makeSftpClient({
      createWriteStream() {
        return new Writable({
          write(_chunk, _encoding, callback) {
            callback(new Error('remote disk full'));
          }
        }) as ReturnType<SFTPWrapper['createWriteStream']>;
      }
    });
    await assert.rejects(sftp.uploadFile(source, '/remote'), /remote disk full/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('SFTP upload rejects a close before the expected bytes are acknowledged', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sshx-upload-short-'));
  const source = path.join(directory, 'source.txt');
  fs.writeFileSync(source, 'some data');
  try {
    const sftp = makeSftpClient({
      createWriteStream() {
        const stream = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
        stream.once('finish', () => stream.emit('close'));
        return stream as ReturnType<SFTPWrapper['createWriteStream']>;
      }
    });
    await assert.rejects(sftp.uploadFile(source, '/remote'), /closed before completion/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

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
