import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Client, SFTPWrapper } from 'ssh2';

export interface RemoteFileInfo {
  filename: string;
  path: string;
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink: boolean;
  size: number;
  modifyTime: Date;
  accessTime: Date;
  permissions: number;
  modeString: string;
}

export interface TransferProgress {
  bytesTransferred: number;
  totalBytes: number;
  percent: number;
  speedBps: number;
  currentFile: string;
}

export type ProgressCallback = (progress: TransferProgress) => void;

export class SFTPClient {
  private client: Client;
  private sftpWrapper?: SFTPWrapper;
  private sftpPromise?: Promise<SFTPWrapper>;

  constructor(client: Client) {
    this.client = client;
  }

  public async getWrapper(): Promise<SFTPWrapper> {
    if (this.sftpWrapper) return this.sftpWrapper;
    if (this.sftpPromise) return this.sftpPromise;

    const pending = new Promise<SFTPWrapper>((resolve, reject) => {
      this.client.sftp((err: Error | undefined, sftp: SFTPWrapper) => {
        if (err) return reject(err);
        this.sftpWrapper = sftp;
        sftp.once('close', () => {
          if (this.sftpWrapper === sftp) this.sftpWrapper = undefined;
        });
        resolve(sftp);
      });
    });
    this.sftpPromise = pending;
    try {
      return await pending;
    } finally {
      if (this.sftpPromise === pending) this.sftpPromise = undefined;
    }
  }

  /**
   * List files in remote directory with rich metadata
   */
  public async list(remotePath: string = '.'): Promise<RemoteFileInfo[]> {
    const sftp = await this.getWrapper();

    return new Promise<RemoteFileInfo[]>((resolve, reject) => {
      sftp.readdir(remotePath, (err, list) => {
        if (err) return reject(err);
        let results: RemoteFileInfo[];
        try {
          results = list.map((item) => {
            validateRemoteName(item.filename);
            const mode = item.attrs.mode || 0;
            const isDir = (mode & 0o170000) === 0o040000;
            const isSymlink = (mode & 0o170000) === 0o120000;
            const isFile = (mode & 0o170000) === 0o100000 || (!isDir && !isSymlink);

            return {
              filename: item.filename,
              path: path.posix.join(remotePath, item.filename),
              isDirectory: isDir,
              isFile,
              isSymbolicLink: isSymlink,
              size: item.attrs.size || 0,
              modifyTime: new Date((item.attrs.mtime || 0) * 1000),
              accessTime: new Date((item.attrs.atime || 0) * 1000),
              permissions: mode & 0o777,
              modeString: formatModeString(mode)
            };
          });
        } catch (error) {
          reject(error);
          return;
        }

        // Sort directories first, then alphabetical
        results.sort((a, b) => {
          if (a.isDirectory && !b.isDirectory) return -1;
          if (!a.isDirectory && b.isDirectory) return 1;
          return a.filename.localeCompare(b.filename);
        });

        resolve(results);
      });
    });
  }

  /**
   * Get file attributes (stat)
   */
  public async stat(remotePath: string): Promise<RemoteFileInfo> {
    const sftp = await this.getWrapper();

    return new Promise<RemoteFileInfo>((resolve, reject) => {
      sftp.stat(remotePath, (err, stats) => {
        if (err) return reject(err);

        const mode = stats.mode || 0;
        const isDir = (mode & 0o170000) === 0o040000;
        const isSymlink = (mode & 0o170000) === 0o120000;
        const isFile = (mode & 0o170000) === 0o100000 || (!isDir && !isSymlink);

        resolve({
          filename: path.posix.basename(remotePath),
          path: remotePath,
          isDirectory: isDir,
          isFile,
          isSymbolicLink: isSymlink,
          size: stats.size || 0,
          modifyTime: new Date((stats.mtime || 0) * 1000),
          accessTime: new Date((stats.atime || 0) * 1000),
          permissions: mode & 0o777,
          modeString: formatModeString(mode)
        });
      });
    });
  }

  /**
   * Check if remote path exists
   */
  public async exists(remotePath: string): Promise<boolean> {
    try {
      await this.stat(remotePath);
      return true;
    } catch (error) {
      if (isMissingFile(error)) return false;
      throw error;
    }
  }

  /**
   * Read remote file content
   */
  public async readFile(remotePath: string, encoding: BufferEncoding = 'utf8'): Promise<string> {
    const sftp = await this.getWrapper();

    return new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const stream = sftp.createReadStream(remotePath);

      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString(encoding)));
      stream.on('error', (err: Error) => reject(err));
    });
  }

  /**
   * Write remote file content
   */
  public async writeFile(remotePath: string, content: string | Buffer): Promise<void> {
    const sftp = await this.getWrapper();
    await this.writeTemporaryFile(remotePath, async (temporaryPath) => {
      await new Promise<void>((resolve, reject) => {
        sftp.writeFile(temporaryPath, content, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    });
  }

  /**
   * Upload single file from local to remote with progress tracking
   */
  public async uploadFile(
    localPath: string,
    remotePath: string,
    onProgress?: ProgressCallback
  ): Promise<void> {
    const stat = fs.lstatSync(localPath);
    if (stat.isSymbolicLink()) throw new Error(`Cannot upload a symbolic link: ${localPath}`);
    if (!stat.isFile()) throw new Error(`Local path is not a regular file: ${localPath}`);
    const sftp = await this.getWrapper();
    const totalBytes = stat.size;
    let bytesTransferred = 0;
    const startTime = Date.now();

    await this.writeTemporaryFile(remotePath, (temporaryPath) => new Promise<void>((resolve, reject) => {
      const readStream = fs.createReadStream(localPath);
      const writeStream = sftp.createWriteStream(temporaryPath);
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (error) {
          readStream.destroy();
          writeStream.destroy();
          reject(error);
        } else resolve();
      };

      readStream.on('data', (chunk: Buffer) => {
        bytesTransferred += chunk.length;
        if (onProgress) {
          try {
            const elapsedSec = (Date.now() - startTime) / 1000 || 0.001;
            onProgress({
              bytesTransferred,
              totalBytes,
              percent: totalBytes > 0 ? Math.min(100, Math.round((bytesTransferred / totalBytes) * 100)) : 100,
              speedBps: Math.round(bytesTransferred / elapsedSec),
              currentFile: path.basename(localPath)
            });
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
          }
        }
      });

      writeStream.once('close', () => {
        const bytesWritten = (writeStream as typeof writeStream & { bytesWritten?: number }).bytesWritten;
        finish(writeStream.errored ?? (bytesWritten === totalBytes
          ? undefined
          : new Error(`SFTP upload closed before completion: ${remotePath}`)));
      });
      writeStream.once('error', finish);
      readStream.once('error', finish);
      readStream.pipe(writeStream);
    }));
  }

  private async writeTemporaryFile(remotePath: string, write: (temporaryPath: string) => Promise<void>): Promise<void> {
    const sftp = await this.getWrapper();
    const temporaryPath = path.posix.join(
      path.posix.dirname(remotePath),
      `.${path.posix.basename(remotePath)}.sshx-${randomUUID()}.tmp`
    );

    try {
      await write(temporaryPath);
      const existingMode = await new Promise<number | undefined>((resolve, reject) => {
        sftp.lstat(remotePath, (error, stats) => {
          if (isMissingFile(error)) resolve(undefined);
          else if (error) reject(error);
          else if ((stats.mode & fs.constants.S_IFMT) !== fs.constants.S_IFREG) {
            reject(new Error(`Cannot replace a non-file SFTP destination: ${remotePath}`));
          } else resolve(stats.mode & 0o777);
        });
      });

      if (existingMode !== undefined) {
        await new Promise<void>((resolve, reject) => {
          sftp.chmod(temporaryPath, existingMode, (error) => error ? reject(error) : resolve());
        });
      }

      let supportsPosixRename = typeof sftp.ext_openssh_rename === 'function';
      if (supportsPosixRename) {
        try {
          await new Promise<void>((resolve, reject) => {
            sftp.ext_openssh_rename(temporaryPath, remotePath, (error) => error ? reject(error) : resolve());
          });
          return;
        } catch (error) {
          if ((error as { code?: number }).code !== 8
            && (!(error instanceof Error) || error.message !== 'Server does not support this extended request')) {
            throw error;
          }
          supportsPosixRename = false;
        }
      }

      if (!supportsPosixRename) {
        if (existingMode !== undefined) {
          throw new Error(`SFTP server cannot atomically overwrite ${remotePath} without POSIX rename support`);
        }
        await new Promise<void>((resolve, reject) => {
          sftp.rename(temporaryPath, remotePath, (error) => error ? reject(error) : resolve());
        });
      }
    } catch (error) {
      try {
        await new Promise<void>((resolve, reject) => {
          sftp.unlink(temporaryPath, (cleanupError) => cleanupError ? reject(cleanupError) : resolve());
        });
      } catch (cleanupError) {
        if (!isMissingFile(cleanupError)) {
          throw new AggregateError([error, cleanupError], `SFTP transfer failed and temporary file could not be removed: ${temporaryPath}`);
        }
      }
      throw error;
    }
  }

  /**
   * Download single file from remote to local with progress tracking
   */
  public async downloadFile(
    remotePath: string,
    localPath: string,
    onProgress?: ProgressCallback
  ): Promise<void> {
    const sftp = await this.getWrapper();
    const remoteStat = await this.stat(remotePath);
    const totalBytes = remoteStat.size;
    let bytesTransferred = 0;
    const startTime = Date.now();

    const localDir = path.dirname(path.resolve(localPath));
    ensureLocalDirectory(localDir);

    const temporaryPath = path.join(localDir, `.${path.basename(localPath)}.sshx-${randomUUID()}.tmp`);
    try {
      const readStream = sftp.createReadStream(remotePath);
      const writeStream = fs.createWriteStream(temporaryPath, { flags: 'wx', mode: 0o666 });
      readStream.on('data', (chunk: Buffer) => {
        bytesTransferred += chunk.length;
        if (onProgress) {
          try {
            const elapsedSec = (Date.now() - startTime) / 1000 || 0.001;
            onProgress({
              bytesTransferred,
              totalBytes,
              percent: totalBytes > 0 ? Math.min(100, Math.round((bytesTransferred / totalBytes) * 100)) : 100,
              speedBps: Math.round(bytesTransferred / elapsedSec),
              currentFile: path.posix.basename(remotePath)
            });
          } catch (error) {
            readStream.destroy(error instanceof Error ? error : new Error(String(error)));
          }
        }
      });
      await pipeline(readStream, writeStream);
      fs.renameSync(temporaryPath, localPath);
    } catch (error) {
      try {
        fs.unlinkSync(temporaryPath);
      } catch (cleanupError) {
        if (!isMissingFile(cleanupError)) throw new AggregateError([error, cleanupError], `Failed to clean up partial download: ${localPath}`);
      }
      throw error;
    }
  }

  /**
   * Create directory on remote host (supports recursive mkdir -p)
   */
  public async mkdir(remotePath: string, recursive: boolean = true): Promise<void> {
    const sftp = await this.getWrapper();

    if (!recursive) {
      return new Promise<void>((resolve, reject) => {
        sftp.mkdir(remotePath, (err) => {
          if (err) return reject(err);
          resolve();
        });
      });
    }

    const parts = remotePath.split('/').filter(Boolean);
    let current = remotePath.startsWith('/') ? '/' : '';

    for (const part of parts) {
      current = path.posix.join(current, part);
      try {
        const type = await this.remoteFileType(current);
        if (type === fs.constants.S_IFLNK) throw new Error(`Cannot upload through a symbolic link: ${current}`);
        if (type !== fs.constants.S_IFDIR) throw new Error(`Remote path is not a directory: ${current}`);
        continue;
      } catch (error) {
        if (!isMissingFile(error)) throw error;
      }
      try {
        await new Promise<void>((resolve, reject) => {
          sftp.mkdir(current, (err) => err ? reject(err) : resolve());
        });
      } catch (error) {
        if ((error as { code?: number }).code !== 4) throw error;
        const createdByAnotherClient = await this.remoteFileType(current).then(type => type === fs.constants.S_IFDIR, () => false);
        if (createdByAnotherClient) continue;
        throw error;
      }
    }
  }

  /**
   * Delete remote file or directory (supports recursive rm -rf)
   */
  public async rm(remotePath: string, recursive: boolean = true): Promise<void> {
    if (recursive) {
      const segments = remotePath.split('/').filter(Boolean);
      const normalized = path.posix.normalize(remotePath);
      if (!remotePath.trim() || segments.includes('..') || normalized === '/' || normalized === '.' || normalized === './' || normalized === '..') {
        throw new Error(`Unsafe recursive SFTP removal path: ${remotePath}`);
      }
    }
    const sftp = await this.getWrapper();
    const entryPath = remotePath.replace(/\/+$/, '') || remotePath;
    const fileType = await new Promise<number>((resolve, reject) => {
      sftp.lstat(entryPath, (err, stats) => {
        if (err) return reject(err);
        const fileType = (stats?.mode ?? 0) & fs.constants.S_IFMT;
        resolve(fileType);
      });
    });

    if (fileType !== fs.constants.S_IFDIR) {
      const unlinkable = [
        fs.constants.S_IFREG,
        fs.constants.S_IFLNK,
        fs.constants.S_IFBLK,
        fs.constants.S_IFCHR,
        fs.constants.S_IFIFO,
        fs.constants.S_IFSOCK
      ];
      if (!unlinkable.includes(fileType)) {
        throw new Error(`Cannot determine remote file type: ${entryPath}`);
      }
      return new Promise<void>((resolve, reject) => {
        sftp.unlink(entryPath, (err) => {
          if (err) return reject(err);
          resolve();
        });
      });
    }

    if (!recursive) {
      return new Promise<void>((resolve, reject) => {
        sftp.rmdir(entryPath, (err) => {
          if (err) return reject(err);
          resolve();
        });
      });
    }

    // Recursive directory removal
    const entries = await this.list(entryPath);
    for (const entry of entries) {
      if (entry.filename === '.' || entry.filename === '..') continue;
      await this.rm(entry.path, true);
    }

    return new Promise<void>((resolve, reject) => {
      sftp.rmdir(entryPath, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  /**
   * Rename or move remote file
   */
  public async rename(oldPath: string, newPath: string): Promise<void> {
    const sftp = await this.getWrapper();
    return new Promise<void>((resolve, reject) => {
      sftp.rename(oldPath, newPath, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  /**
   * Change permissions of remote file
   */
  public async chmod(remotePath: string, mode: number): Promise<void> {
    const sftp = await this.getWrapper();
    return new Promise<void>((resolve, reject) => {
      sftp.chmod(remotePath, mode, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  /**
   * Recursive directory upload
   */
  public async uploadDir(
    localDir: string,
    remoteDir: string,
    onProgress?: ProgressCallback
  ): Promise<void> {
    const source = fs.lstatSync(localDir);
    if (source.isSymbolicLink()) throw new Error(`Cannot upload a symbolic link: ${localDir}`);
    if (!source.isDirectory()) throw new Error(`Local path is not a directory: ${localDir}`);
    await this.mkdir(remoteDir, true);
    const items = fs.readdirSync(localDir);

    for (const item of items) {
      const localItemPath = path.join(localDir, item);
      const remoteItemPath = path.posix.join(remoteDir, item);
      const stat = fs.lstatSync(localItemPath);

      if (stat.isSymbolicLink()) {
        throw new Error(`Cannot upload a symbolic link: ${localItemPath}`);
      } else if (stat.isDirectory()) {
        await this.uploadDir(localItemPath, remoteItemPath, onProgress);
      } else if (stat.isFile()) {
        await this.uploadFile(localItemPath, remoteItemPath, onProgress);
      } else {
        throw new Error(`Cannot upload a non-file entry: ${localItemPath}`);
      }
    }
  }

  /**
   * Recursive directory download
   */
  public async downloadDir(
    remoteDir: string,
    localDir: string,
    onProgress?: ProgressCallback
  ): Promise<void> {
    const remoteType = await this.remoteFileType(remoteDir);
    if (remoteType === fs.constants.S_IFLNK) throw new Error(`Cannot download a symbolic link: ${remoteDir}`);
    if (remoteType !== fs.constants.S_IFDIR) throw new Error(`Remote path is not a directory: ${remoteDir}`);
    ensureLocalDirectory(localDir);
    await this.downloadDirectoryEntries(remoteDir, localDir, onProgress);
  }

  private async downloadDirectoryEntries(remoteDir: string, localDir: string, onProgress?: ProgressCallback): Promise<void> {
    const items = await this.list(remoteDir);
    for (const item of items) {
      if (item.filename === '.' || item.filename === '..') continue;
      const entryType = await this.remoteFileType(item.path);
      if (entryType === fs.constants.S_IFLNK) throw new Error(`Cannot download a symbolic link: ${item.path}`);
      const localItemPath = path.join(localDir, item.filename);

      if (entryType === fs.constants.S_IFDIR) {
        ensureLocalDirectory(localItemPath);
        await this.downloadDirectoryEntries(item.path, localItemPath, onProgress);
      } else if (entryType === fs.constants.S_IFREG) {
        await this.downloadFile(item.path, localItemPath, onProgress);
      } else {
        throw new Error(`Cannot download a non-file entry: ${item.path}`);
      }
    }
  }

  private async remoteFileType(remotePath: string): Promise<number> {
    const sftp = await this.getWrapper();
    return new Promise<number>((resolve, reject) => {
      sftp.lstat(remotePath, (error, stats) => error ? reject(error) : resolve(stats.mode & fs.constants.S_IFMT));
    });
  }
}

function validateRemoteName(name: string): void {
  if (!name || name.includes('/') || name.includes('\\') || name.includes('\0') || /^[a-zA-Z]:/.test(name)) {
    throw new Error(`Invalid remote entry name: ${JSON.stringify(name)}`);
  }
}

function ensureLocalDirectory(directory: string): void {
  const missing: string[] = [];
  let current = path.resolve(directory);
  while (true) {
    try {
      const stats = fs.lstatSync(current);
      if (stats.isSymbolicLink()) throw new Error(`Cannot download through a symbolic link: ${current}`);
      if (!stats.isDirectory()) throw new Error(`Local path is not a directory: ${current}`);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      missing.push(current);
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const next of missing.reverse()) {
    try {
      fs.mkdirSync(next);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const stats = fs.lstatSync(next);
    if (stats.isSymbolicLink()) throw new Error(`Cannot download through a symbolic link: ${next}`);
    if (!stats.isDirectory()) throw new Error(`Local path is not a directory: ${next}`);
  }
}

function isMissingFile(error: unknown): boolean {
  return (error as { code?: number | string } | null)?.code === 2
    || (error as { code?: number | string } | null)?.code === 'ENOENT';
}

/**
 * Converts numeric unix mode to standard string representation (e.g. drwxr-xr-x)
 */
function formatModeString(mode: number): string {
  let type = '-';
  if ((mode & 0o170000) === 0o040000) type = 'd';
  else if ((mode & 0o170000) === 0o120000) type = 'l';
  else if ((mode & 0o170000) === 0o020000) type = 'c';
  else if ((mode & 0o170000) === 0o060000) type = 'b';

  const rwx = [
    (mode & 0o400) ? 'r' : '-',
    (mode & 0o200) ? 'w' : '-',
    (mode & 0o100) ? 'x' : '-',
    (mode & 0o040) ? 'r' : '-',
    (mode & 0o020) ? 'w' : '-',
    (mode & 0o010) ? 'x' : '-',
    (mode & 0o004) ? 'r' : '-',
    (mode & 0o002) ? 'w' : '-',
    (mode & 0o001) ? 'x' : '-'
  ].join('');

  return type + rwx;
}
