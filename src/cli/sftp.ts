import path from 'node:path';
import fs from 'node:fs';
import { resolveTarget, prepareCliConnection, ConnectCliOptions } from './connect.js';
import { SSHConnection } from '../core/client.js';
import { SFTPClient, TransferProgress } from '../core/sftp.js';
import { colors, formatBytes, renderTable } from './utils.js';
import { errorMessage } from '../core/errors.js';

export interface SftpCliOptions extends ConnectCliOptions {
  recursive?: boolean;
}

export async function runSftpLs(target: string, remotePath: string = '.', options: SftpCliOptions = {}): Promise<void> {
  const profile = resolveTarget(target, options);
  const conn = new SSHConnection(await prepareCliConnection(profile));

  try {
    await conn.connect();
    const sftp = new SFTPClient(conn.getRawClient());
    const files = await sftp.list(remotePath);
    conn.disconnect();

    const rows = files.map(f => [
      f.modeString,
      formatBytes(f.size),
      f.modifyTime.toLocaleString(),
      f.isDirectory ? `${colors.blue}${f.filename}/${colors.reset}` : f.filename
    ]);

    process.stdout.write(renderTable(['Permissions', 'Size', 'Modified', 'Name'], rows) + '\n');
  } catch (err) {
    conn.disconnect();
    process.stderr.write(`${colors.red}SFTP error: ${errorMessage(err)}${colors.reset}\n`);
    process.exit(1);
  }
}

export async function runSftpGet(
  target: string,
  remotePath: string,
  localPath?: string,
  options: SftpCliOptions = {}
): Promise<void> {
  const profile = resolveTarget(target, options);
  const conn = new SSHConnection(await prepareCliConnection(profile));

  try {
    await conn.connect();
    const sftp = new SFTPClient(conn.getRawClient());
    let dest = localPath || path.posix.basename(remotePath);

    const stat = await sftp.stat(remotePath);
    if (!stat.isDirectory && fs.existsSync(dest) && fs.statSync(dest).isDirectory()) {
      dest = path.join(dest, path.posix.basename(remotePath));
    }
    const onProgress = (p: TransferProgress) => {
      const speedStr = `${formatBytes(p.speedBps)}/s`;
      process.stdout.write(`\rDownloading ${p.currentFile} [${p.percent}%] ${formatBytes(p.bytesTransferred)}/${formatBytes(p.totalBytes)} (${speedStr})\x1b[K`);
    };

    if (stat.isDirectory) {
      process.stdout.write(`Downloading directory ${remotePath} -> ${dest}...\n`);
      await sftp.downloadDir(remotePath, dest, onProgress);
    } else {
      await sftp.downloadFile(remotePath, dest, onProgress);
    }
    process.stdout.write(`\n${colors.green}✓ Download completed successfully: ${dest}${colors.reset}\n`);

    conn.disconnect();
  } catch (err) {
    conn.disconnect();
    process.stderr.write(`\n${colors.red}SFTP download error: ${errorMessage(err)}${colors.reset}\n`);
    process.exit(1);
  }
}

export async function runSftpPut(
  target: string,
  localPath: string,
  remotePath?: string,
  options: SftpCliOptions = {}
): Promise<void> {
  const profile = resolveTarget(target, options);
  const conn = new SSHConnection(await prepareCliConnection(profile));

  try {
    const resolvedLocal = path.resolve(localPath);
    if (!fs.existsSync(resolvedLocal)) {
      throw new Error(`Local file not found: ${resolvedLocal}`);
    }

    await conn.connect();
    const sftp = new SFTPClient(conn.getRawClient());
    let dest = remotePath || path.basename(resolvedLocal);

    const stat = fs.lstatSync(resolvedLocal);
    if (!stat.isDirectory() && remotePath) {
      if (remotePath.endsWith('/')) {
        dest = path.posix.join(remotePath, path.basename(resolvedLocal));
      } else {
        const remoteStat = await sftp.stat(remotePath).catch(() => undefined);
        if (remoteStat?.isDirectory) {
          dest = path.posix.join(remotePath, path.basename(resolvedLocal));
        }
      }
    }
    const onProgress = (p: TransferProgress) => {
      const speedStr = `${formatBytes(p.speedBps)}/s`;
      process.stdout.write(`\rUploading ${p.currentFile} [${p.percent}%] ${formatBytes(p.bytesTransferred)}/${formatBytes(p.totalBytes)} (${speedStr})\x1b[K`);
    };

    if (stat.isDirectory()) {
      process.stdout.write(`Uploading directory ${localPath} -> ${dest}...\n`);
      await sftp.uploadDir(resolvedLocal, dest, onProgress);
    } else {
      await sftp.uploadFile(resolvedLocal, dest, onProgress);
    }
    process.stdout.write(`\n${colors.green}✓ Upload completed successfully: ${dest}${colors.reset}\n`);

    conn.disconnect();
  } catch (err) {
    conn.disconnect();
    process.stderr.write(`\n${colors.red}SFTP upload error: ${errorMessage(err)}${colors.reset}\n`);
    process.exit(1);
  }
}

export async function runSftpRm(target: string, remotePath: string, options: SftpCliOptions = {}): Promise<void> {
  const profile = resolveTarget(target, options);
  const conn = new SSHConnection(await prepareCliConnection(profile));

  try {
    await conn.connect();
    const sftp = new SFTPClient(conn.getRawClient());
    await sftp.rm(remotePath, options.recursive ?? false);
    conn.disconnect();
    process.stdout.write(`${colors.green}✓ Removed: ${remotePath}${colors.reset}\n`);
  } catch (err) {
    conn.disconnect();
    process.stderr.write(`${colors.red}SFTP rm error: ${errorMessage(err)}${colors.reset}\n`);
    process.exit(1);
  }
}
