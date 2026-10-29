import fs from 'node:fs';
import path from 'node:path';
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

  constructor(client: Client) {
    this.client = client;
  }

  public async getWrapper(): Promise<SFTPWrapper> {
    if (this.sftpWrapper) return this.sftpWrapper;

    return new Promise<SFTPWrapper>((resolve, reject) => {
      this.client.sftp((err: Error | undefined, sftp: SFTPWrapper) => {
        if (err) return reject(err);
        this.sftpWrapper = sftp;
        resolve(sftp);
      });
    });
  }

  /**
   * List files in remote directory with rich metadata
   */
  public async list(remotePath: string = '.'): Promise<RemoteFileInfo[]> {
    const sftp = await this.getWrapper();

    return new Promise<RemoteFileInfo[]>((resolve, reject) => {
      sftp.readdir(remotePath, (err, list) => {
        if (err) return reject(err);

        const results: RemoteFileInfo[] = list.map((item) => {
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
    } catch {
      return false;
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

    return new Promise<void>((resolve, reject) => {
      const stream = sftp.createWriteStream(remotePath);
      let done = false;
      const onDone = () => {
        if (!done) {
          done = true;
          resolve();
        }
      };
      stream.once('finish', onDone);
      stream.once('close', onDone);
      stream.once('error', (err: Error) => {
        if (!done) {
          done = true;
          reject(err);
        }
      });
      stream.end(Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'));
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
    const sftp = await this.getWrapper();
    const stat = fs.statSync(localPath);
    const totalBytes = stat.size;
    let bytesTransferred = 0;
    const startTime = Date.now();

    return new Promise<void>((resolve, reject) => {
      const readStream = fs.createReadStream(localPath);
      const writeStream = sftp.createWriteStream(remotePath);

      readStream.on('data', (chunk: Buffer) => {
        bytesTransferred += chunk.length;
        if (onProgress) {
          const elapsedSec = (Date.now() - startTime) / 1000 || 0.001;
          const speedBps = Math.round(bytesTransferred / elapsedSec);
          const percent = totalBytes > 0 ? Math.min(100, Math.round((bytesTransferred / totalBytes) * 100)) : 100;
          onProgress({
            bytesTransferred,
            totalBytes,
            percent,
            speedBps,
            currentFile: path.basename(localPath)
          });
        }
      });

      writeStream.on('close', () => resolve());
      writeStream.on('error', (err: Error) => reject(err));
      readStream.on('error', (err: Error) => reject(err));

      readStream.pipe(writeStream);
    });
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
    if (!fs.existsSync(localDir)) {
      fs.mkdirSync(localDir, { recursive: true });
    }

    return new Promise<void>((resolve, reject) => {
      const readStream = sftp.createReadStream(remotePath);
      const writeStream = fs.createWriteStream(localPath);

      readStream.on('data', (chunk: Buffer) => {
        bytesTransferred += chunk.length;
        if (onProgress) {
          const elapsedSec = (Date.now() - startTime) / 1000 || 0.001;
          const speedBps = Math.round(bytesTransferred / elapsedSec);
          const percent = totalBytes > 0 ? Math.min(100, Math.round((bytesTransferred / totalBytes) * 100)) : 100;
          onProgress({
            bytesTransferred,
            totalBytes,
            percent,
            speedBps,
            currentFile: path.posix.basename(remotePath)
          });
        }
      });

      writeStream.on('close', () => resolve());
      writeStream.on('error', (err: Error) => reject(err));
      readStream.on('error', (err: Error) => reject(err));

      readStream.pipe(writeStream);
    });
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
      const isPresent = await this.exists(current);
      if (!isPresent) {
        await new Promise<void>((resolve, reject) => {
          sftp.mkdir(current, (err) => {
            if (err && (err as any).code !== 4) return reject(err); // code 4 = SSH_FX_FAILURE (often already exists)
            resolve();
          });
        });
      }
    }
  }

  /**
   * Delete remote file or directory (supports recursive rm -rf)
   */
  public async rm(remotePath: string, recursive: boolean = true): Promise<void> {
    const sftp = await this.getWrapper();
    const stat = await this.stat(remotePath);

    if (!stat.isDirectory) {
      return new Promise<void>((resolve, reject) => {
        sftp.unlink(remotePath, (err) => {
          if (err) return reject(err);
          resolve();
        });
      });
    }

    if (!recursive) {
      return new Promise<void>((resolve, reject) => {
        sftp.rmdir(remotePath, (err) => {
          if (err) return reject(err);
          resolve();
        });
      });
    }

    // Recursive directory removal
    const entries = await this.list(remotePath);
    for (const entry of entries) {
      if (entry.filename === '.' || entry.filename === '..') continue;
      await this.rm(entry.path, true);
    }

    return new Promise<void>((resolve, reject) => {
      sftp.rmdir(remotePath, (err) => {
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
    await this.mkdir(remoteDir, true);
    const items = fs.readdirSync(localDir);

    for (const item of items) {
      const localItemPath = path.join(localDir, item);
      const remoteItemPath = path.posix.join(remoteDir, item);
      const stat = fs.statSync(localItemPath);

      if (stat.isDirectory()) {
        await this.uploadDir(localItemPath, remoteItemPath, onProgress);
      } else {
        await this.uploadFile(localItemPath, remoteItemPath, onProgress);
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
    if (!fs.existsSync(localDir)) {
      fs.mkdirSync(localDir, { recursive: true });
    }

    const items = await this.list(remoteDir);
    for (const item of items) {
      if (item.filename === '.' || item.filename === '..') continue;
      const localItemPath = path.join(localDir, item.filename);

      if (item.isDirectory) {
        await this.downloadDir(item.path, localItemPath, onProgress);
      } else {
        await this.downloadFile(item.path, localItemPath, onProgress);
      }
    }
  }
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
