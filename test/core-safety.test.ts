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
    lstat(_remotePath, callback) {
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

test('SFTP recursive mkdir refuses remote symbolic-link directory components', async () => {
  const calls: string[] = [];
  const sftp = makeSftpClient({
    lstat(remotePath, callback) {
      calls.push(`lstat ${remotePath}`);
      const mode = remotePath === '/linked' ? fsConstants.S_IFLNK : fsConstants.S_IFDIR;
      callback(undefined, { mode } as Parameters<typeof callback>[1]);
    },
    mkdir() { assert.fail('must not create files inside a symlinked directory'); }
  });
  await assert.rejects(sftp.mkdir('/linked/subdir'), /symbolic link/i);
  assert.deepEqual(calls, ['lstat /linked']);
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

test('SFTP download preserves its destination when the progress callback throws', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sshx-download-progress-'));
  const destination = path.join(directory, 'target.txt');
  fs.writeFileSync(destination, 'original');
  const sftp = makeSftpClient({
    stat(_remotePath, callback) {
      callback(undefined, { mode: fsConstants.S_IFREG, size: 4 } as Parameters<typeof callback>[1]);
    },
    createReadStream() {
      return Readable.from([Buffer.from('data')]) as ReturnType<SFTPWrapper['createReadStream']>;
    }
  });
  try {
    await assert.rejects(sftp.downloadFile('/remote', destination, () => {
      throw new Error('progress failed');
    }), /progress failed/);
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
      },
      unlink(_remotePath, callback) {
        callback();
      }
    });
    await assert.rejects(sftp.uploadFile(source, '/remote'), /remote disk full/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('SFTP upload cleans up its temporary file when the progress callback throws', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sshx-upload-progress-'));
  const source = path.join(directory, 'source.txt');
  fs.writeFileSync(source, 'some data');
  const removed: string[] = [];
  const sftp = makeSftpClient({
    createWriteStream() {
      return new Writable({ write(_chunk, _encoding, callback) { callback(); } }) as ReturnType<SFTPWrapper['createWriteStream']>;
    },
    unlink(remotePath, callback) {
      removed.push(remotePath);
      callback();
    }
  });
  try {
    await assert.rejects(sftp.uploadFile(source, '/remote.txt', () => {
      throw new Error('progress failed');
    }), /progress failed/);
    assert.equal(removed.length, 1);
    assert.match(removed[0], /^\/\.remote\.txt\.sshx-.*\.tmp$/);
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
      },
      unlink(_remotePath, callback) {
        callback();
      }
    });
    await assert.rejects(sftp.uploadFile(source, '/remote'), /closed before completion/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('SFTP write keeps an existing file intact when the server lacks atomic replacement', async () => {
  const files = new Map([['/existing.txt', 'original']]);
  const sftp = makeSftpClient({
    writeFile(remotePath, content, callback) {
      files.set(remotePath, String(content));
      callback?.();
    },
    lstat(_remotePath, callback) {
      callback(undefined, { mode: fsConstants.S_IFREG | 0o640 } as Parameters<typeof callback>[1]);
    },
    chmod(_remotePath, _mode, callback) { callback(); },
    rename() { assert.fail('regular rename cannot atomically replace an existing destination'); },
    unlink(remotePath, callback) {
      files.delete(remotePath);
      callback();
    }
  });

  await assert.rejects(sftp.writeFile('/existing.txt', 'replacement'), /cannot atomically overwrite/);
  assert.deepEqual([...files], [['/existing.txt', 'original']]);
});

test('SFTP write atomically replaces an existing file when POSIX rename is supported', async () => {
  const files = new Map([['/existing.txt', 'original']]);
  let temporaryMode: number | undefined;
  const sftp = makeSftpClient({
    writeFile(remotePath, content, callback) {
      files.set(remotePath, String(content));
      callback?.();
    },
    lstat(_remotePath, callback) {
      callback(undefined, { mode: fsConstants.S_IFREG | 0o640 } as Parameters<typeof callback>[1]);
    },
    chmod(_remotePath, mode, callback) {
      temporaryMode = mode;
      callback();
    },
    ext_openssh_rename(source, destination, callback) {
      assert.equal(files.get(destination), 'original');
      assert.equal(temporaryMode, 0o640);
      files.set(destination, files.get(source)!);
      files.delete(source);
      callback();
    },
    unlink() { assert.fail('successful transfer must not delete its temporary file twice'); }
  });

  await sftp.writeFile('/existing.txt', 'replacement');
  assert.deepEqual([...files], [['/existing.txt', 'replacement']]);
});

test('SFTP refuses to overwrite symbolic links and removes the temporary file', async () => {
  const files = new Map([['/linked.txt', 'original']]);
  const sftp = makeSftpClient({
    writeFile(remotePath, content, callback) {
      files.set(remotePath, String(content));
      callback?.();
    },
    lstat(_remotePath, callback) {
      callback(undefined, { mode: fsConstants.S_IFLNK | 0o777 } as Parameters<typeof callback>[1]);
    },
    ext_openssh_rename() { assert.fail('symbolic link must not be replaced'); },
    unlink(remotePath, callback) {
      files.delete(remotePath);
      callback();
    }
  });

  await assert.rejects(sftp.writeFile('/linked.txt', 'replacement'), /non-file SFTP destination/);
  assert.deepEqual([...files], [['/linked.txt', 'original']]);
});

test('SFTP treats an unsupported POSIX rename as unsafe for overwriting', async () => {
  const files = new Map([['/existing.txt', 'original']]);
  const sftp = makeSftpClient({
    writeFile(remotePath, content, callback) {
      files.set(remotePath, String(content));
      callback?.();
    },
    lstat(_remotePath, callback) {
      callback(undefined, { mode: fsConstants.S_IFREG | 0o600 } as Parameters<typeof callback>[1]);
    },
    chmod(_remotePath, _mode, callback) { callback(); },
    ext_openssh_rename(_source, _destination, callback) {
      callback(Object.assign(new Error('Operation unsupported'), { code: 8 }));
    },
    rename() { assert.fail('unsafe rename must not run after an unsupported POSIX extension'); },
    unlink(remotePath, callback) {
      files.delete(remotePath);
      callback();
    }
  });

  await assert.rejects(sftp.writeFile('/existing.txt', 'replacement'), /cannot atomically overwrite/);
  assert.deepEqual([...files], [['/existing.txt', 'original']]);
});

test('SFTP failed upload removes only its temporary remote file', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sshx-atomic-upload-'));
  const source = path.join(directory, 'source.txt');
  fs.writeFileSync(source, 'new content');
  const files = new Map([['/existing.txt', 'original']]);
  try {
    const sftp = makeSftpClient({
      createWriteStream(remotePath) {
        files.set(remotePath, 'partial');
        return new Writable({ write(_chunk, _encoding, callback) { callback(new Error('remote disk full')); } }) as ReturnType<SFTPWrapper['createWriteStream']>;
      },
      lstat() { assert.fail('failed upload must not touch the destination'); },
      unlink(remotePath, callback) {
        files.delete(remotePath);
        callback();
      }
    });
    await assert.rejects(sftp.uploadFile(source, '/existing.txt'), /remote disk full/);
    assert.deepEqual([...files], [['/existing.txt', 'original']]);
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

test('SFTP recursive rm rejects root, current directory, and parent traversal', async () => {
  const sftp = makeSftpClient({
    lstat() { assert.fail('unsafe recursive deletion must stop before remote access'); },
    readdir() { assert.fail('unsafe recursive deletion must not traverse'); }
  });
  for (const remotePath of ['/', '//', '/tmp/..', '.', './', '..', 'folder/../other']) {
    await assert.rejects(sftp.rm(remotePath, true), /unsafe recursive SFTP removal/i);
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

test('SFTP recursive upload refuses symbolic links instead of following local files or cycles', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sshx-upload-link-'));
  const source = path.join(directory, 'source');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(directory, 'private.txt'), 'not for upload');
  fs.symlinkSync(path.join(directory, 'private.txt'), path.join(source, 'linked.txt'));
  const uploaded: string[] = [];
  const sftp = makeSftpClient({});
  sftp.mkdir = async () => {};
  sftp.uploadFile = async localPath => { uploaded.push(localPath); };
  try {
    await assert.rejects(sftp.uploadDir(source, '/remote'), /symbolic link/i);
    assert.deepEqual(uploaded, []);
    const linkedDirectory = path.join(directory, 'linked-dir');
    fs.symlinkSync(source, linkedDirectory, 'dir');
    await assert.rejects(sftp.uploadDir(linkedDirectory, '/remote'), /symbolic link/i);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('SFTP single-file upload rejects symlinks and special files before writing remotely', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sshx-upload-file-type-'));
  const source = path.join(directory, 'private.txt');
  fs.writeFileSync(source, 'not for upload');
  const linked = path.join(directory, 'linked.txt');
  fs.symlinkSync(source, linked);
  const sftp = makeSftpClient({
    createWriteStream() { assert.fail('must not open a remote file for symlink upload'); }
  });
  try {
    await assert.rejects(sftp.uploadFile(linked, '/remote'), /symbolic link/i);
    await assert.rejects(sftp.uploadFile(directory, '/remote'), /regular file/i);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('SFTP refuses remote names that could escape a recursive download or deletion', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sshx-remote-name-'));
  try {
    for (const filename of ['../outside', '..\\outside', '/outside', 'sub/file']) {
      const sftp = makeSftpClient({
        readdir(_remotePath, callback) {
          callback(undefined, [{ filename, attrs: { mode: fsConstants.S_IFREG } }] as Parameters<typeof callback>[1]);
        },
        unlink() { assert.fail('must not delete a path constructed from an invalid name'); },
        lstat(_remotePath, callback) {
          callback(undefined, { mode: fsConstants.S_IFDIR } as Parameters<typeof callback>[1]);
        }
      });
      await assert.rejects(sftp.downloadDir('/remote', path.join(directory, 'download')), /invalid remote.*name/i);
      await assert.rejects(sftp.rm('/remote', true), /invalid remote.*name/i);
    }
    assert.deepEqual(fs.readdirSync(directory), ['download']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('SFTP recursive download refuses a remote symlink presented as a directory', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sshx-remote-link-'));
  let reads = 0;
  const sftp = makeSftpClient({
    readdir(_remotePath, callback) {
      reads++;
      callback(undefined, [{ filename: 'linked', attrs: { mode: fsConstants.S_IFDIR } }] as Parameters<typeof callback>[1]);
    },
    lstat(_remotePath, callback) {
      callback(undefined, { mode: _remotePath === '/remote' ? fsConstants.S_IFDIR : fsConstants.S_IFLNK } as Parameters<typeof callback>[1]);
    }
  });
  try {
    await assert.rejects(sftp.downloadDir('/remote', directory), /symbolic link/i);
    assert.equal(reads, 1);
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('SFTP recursive download refuses existing local symlink directories', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sshx-local-link-'));
  const destination = path.join(directory, 'destination');
  const outside = path.join(directory, 'outside');
  fs.mkdirSync(destination);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(destination, 'linked'), 'dir');
  const sftp = makeSftpClient({
    readdir(_remotePath, callback) {
      callback(undefined, [{ filename: 'linked', attrs: { mode: fsConstants.S_IFDIR } }] as Parameters<typeof callback>[1]);
    },
    lstat(_remotePath, callback) {
      callback(undefined, { mode: fsConstants.S_IFDIR } as Parameters<typeof callback>[1]);
    }
  });
  try {
    await assert.rejects(sftp.downloadDir('/remote', destination), /symbolic link/i);
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('SFTP download refuses an existing directory beneath a symlinked ancestor', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sshx-local-parent-link-'));
  const outside = path.join(directory, 'outside');
  fs.mkdirSync(path.join(outside, 'existing'), { recursive: true });
  const alias = path.join(directory, 'alias');
  fs.symlinkSync(outside, alias, 'dir');
  const sftp = makeSftpClient({
    lstat(_remotePath, callback) {
      callback(undefined, { mode: fsConstants.S_IFDIR } as Parameters<typeof callback>[1]);
    },
    readdir() { assert.fail('must not read a remote directory before validating local path'); }
  });
  try {
    await assert.rejects(sftp.downloadDir('/remote', path.join(alias, 'existing')), /symbolic link/i);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('SFTP recursive download copies nested regular files without extra directory stats', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sshx-nested-download-'));
  const file = path.join(directory, 'nested', 'message.txt');
  const paths: string[] = [];
  const sftp = makeSftpClient({
    lstat(remotePath, callback) {
      paths.push(remotePath);
      const mode = remotePath.endsWith('.txt') ? fsConstants.S_IFREG : fsConstants.S_IFDIR;
      callback(undefined, { mode } as Parameters<typeof callback>[1]);
    },
    readdir(remotePath, callback) {
      const filename = remotePath === '/remote' ? 'nested' : 'message.txt';
      const mode = filename === 'nested' ? fsConstants.S_IFDIR : fsConstants.S_IFREG;
      callback(undefined, [{ filename, attrs: { mode } }] as Parameters<typeof callback>[1]);
    }
  });
  sftp.downloadFile = async (_remotePath, localPath) => { fs.writeFileSync(localPath, 'hello'); };
  try {
    await sftp.downloadDir('/remote', directory);
    assert.equal(fs.readFileSync(file, 'utf8'), 'hello');
    assert.deepEqual(paths, ['/remote', '/remote/nested', '/remote/nested/message.txt']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
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
