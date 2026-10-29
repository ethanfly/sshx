import ssh2 from 'ssh2';
import type { Server as SshServer } from 'ssh2';
const { Server } = ssh2;
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface MockServerOptions {
  port?: number;
  host?: string;
  username?: string;
  password?: string;
}

export class MockSSHServer {
  private server: SshServer;
  public port: number;
  public host: string;
  public username: string;
  public password: string;
  public hostKeyPem: string;
  public tempDir: string;

  constructor(options: MockServerOptions = {}) {
    this.port = options.port !== undefined ? options.port : 22222;
    this.host = options.host || '127.0.0.1';
    this.username = options.username || 'testuser';
    this.password = options.password || 'testpass';

    // Generate ephemeral RSA host key for mock server
    const { privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' }
    });
    this.hostKeyPem = privateKey;

    this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshx-mock-'));

    this.server = new Server({
      hostKeys: [this.hostKeyPem]
    }, (client) => {
      client.on('authentication', (ctx) => {
        if (ctx.method === 'password' || ctx.method === 'keyboard-interactive') {
          if (ctx.username === this.username && ctx.method === 'keyboard-interactive') {
            ctx.accept();
            return;
          }
          if (ctx.username === this.username && ctx.password === this.password) {
            ctx.accept();
          } else {
            ctx.reject();
          }
        } else if (ctx.method === 'publickey') {
          // Accept any public key for mock server
          ctx.accept();
        } else {
          ctx.reject(['password', 'publickey']);
        }
      });

      client.on('ready', () => {
        client.on('session', (accept) => {
          const session = accept();

          // Handle exec
          session.on('exec', (acceptExec, rejectExec, info) => {
            const stream = acceptExec();
            const cmd = info.command.trim();

            if (cmd === 'echo hello') {
              stream.write('hello\n');
              stream.exit(0);
              stream.end();
            } else if (cmd.startsWith('cat ')) {
              const arg = cmd.slice(4).trim();
              const target = path.join(this.tempDir, arg);
              if (fs.existsSync(target)) {
                stream.write(fs.readFileSync(target));
                stream.exit(0);
              } else {
                stream.stderr.write(`cat: ${arg}: No such file or directory\n`);
                stream.exit(1);
              }
              stream.end();
            } else if (cmd === 'uname -a') {
              stream.write('Linux mock-sshx-test 6.0 #1 SMP\n');
              stream.exit(0);
              stream.end();
            } else {
              stream.write(`Executed: ${cmd}\n`);
              stream.exit(0);
              stream.end();
            }
          });

          // Handle PTY / shell
          session.on('pty', (acceptPty) => {
            acceptPty();
          });

          session.on('shell', (acceptShell) => {
            const stream = acceptShell();
            stream.write('Welcome to Mock SSH Server!\r\n$ ');
            stream.on('data', (data: Buffer) => {
              // Echo back
              if (data.toString() === 'exit\r' || data.toString() === 'exit\n') {
                stream.exit(0);
                stream.end();
              } else {
                stream.write(data);
              }
            });
          });

          // Handle SFTP
          session.on('sftp', (acceptSftp) => {
            const sftpStream = acceptSftp();
            this.setupSftpHandlers(sftpStream);
          });
        });

        // Handle local port forwarding (client requests direct-tcpip)
        client.on('tcpip', (acceptDirect, rejectDirect, info) => {
          const stream = acceptDirect();
          const targetSocket = net.connect(info.destPort, info.destIP, () => {
            stream.pipe(targetSocket).pipe(stream);
          });
          targetSocket.on('error', () => {
            stream.close();
          });
        });

        // Handle remote port forwarding (client requests tcpip-forward)
        client.on('tcpip-forward', (acceptForward, rejectForward, info) => {
          acceptForward();
        });
      });
    });
  }

  private setupSftpHandlers(sftpStream: any): void {
    // Basic SFTP mock implementation mapping to this.tempDir
    sftpStream.on('REALPATH', (reqid: number, str: string) => {
      sftpStream.name(reqid, [{ filename: '/', longname: '/' }]);
    });

    sftpStream.on('STAT', (reqid: number, str: string) => {
      const target = path.join(this.tempDir, str);
      try {
        const stat = fs.statSync(target);
        sftpStream.attrs(reqid, {
          mode: stat.mode,
          size: stat.size,
          mtime: Math.floor(stat.mtimeMs / 1000),
          atime: Math.floor(stat.atimeMs / 1000)
        });
      } catch {
        sftpStream.status(reqid, 2); // SSH_FX_NO_SUCH_FILE
      }
    });

    const openDirs = new Map<string, { done: boolean }>();
    const openFiles = new Map<string, number>();

    sftpStream.on('OPENDIR', (reqid: number, str: string) => {
      const handle = Buffer.from(`dir_${Math.random()}`);
      openDirs.set(handle.toString('hex'), { done: false });
      sftpStream.handle(reqid, handle);
    });

    sftpStream.on('READDIR', (reqid: number, handle: Buffer) => {
      const state = openDirs.get(handle.toString('hex'));
      if (!state || state.done) {
        sftpStream.status(reqid, 1); // SSH_FX_EOF
        return;
      }

      state.done = true;
      const items = fs.readdirSync(this.tempDir);
      const names = items.map(name => {
        const stat = fs.statSync(path.join(this.tempDir, name));
        return {
          filename: name,
          longname: `${stat.isDirectory() ? 'd' : '-'}rw-r--r-- 1 test test ${stat.size} Oct 29 10:00 ${name}`,
          attrs: {
            mode: stat.mode,
            size: stat.size,
            mtime: Math.floor(stat.mtimeMs / 1000),
            atime: Math.floor(stat.atimeMs / 1000)
          }
        };
      });
      sftpStream.name(reqid, names);
    });

    sftpStream.on('OPEN', (reqid: number, filename: string, flags: number) => {
      const target = path.join(this.tempDir, filename);
      const handle = Buffer.from(`file_${Math.random()}`);
      try {
        let fd: number;
        if (flags & 0x00000002) { // WRITE
          const dir = path.dirname(target);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fd = fs.openSync(target, 'w+');
        } else {
          fd = fs.openSync(target, 'r');
        }
        openFiles.set(handle.toString('hex'), fd);
        sftpStream.handle(reqid, handle);
      } catch {
        sftpStream.status(reqid, 2);
      }
    });

    sftpStream.on('WRITE', (reqid: number, handle: Buffer, offset: number, data: Buffer) => {
      const fd = openFiles.get(handle.toString('hex'));
      if (fd !== undefined) {
        fs.writeSync(fd, data, 0, data.length, offset);
        sftpStream.status(reqid, 0); // SSH_FX_OK
      } else {
        sftpStream.status(reqid, 4); // SSH_FX_FAILURE
      }
    });

    sftpStream.on('READ', (reqid: number, handle: Buffer, offset: number, length: number) => {
      const fd = openFiles.get(handle.toString('hex'));
      if (fd !== undefined) {
        const buf = Buffer.alloc(length);
        const bytesRead = fs.readSync(fd, buf, 0, length, offset);
        if (bytesRead === 0) {
          sftpStream.status(reqid, 1); // SSH_FX_EOF
        } else {
          sftpStream.data(reqid, buf.subarray(0, bytesRead));
        }
      } else {
        sftpStream.status(reqid, 4);
      }
    });

    sftpStream.on('CLOSE', (reqid: number, handle: Buffer) => {
      const key = handle.toString('hex');
      const fd = openFiles.get(key);
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
        openFiles.delete(key);
      }
      openDirs.delete(key);
      sftpStream.status(reqid, 0); // SSH_FX_OK
    });

    sftpStream.on('MKDIR', (reqid: number, str: string) => {
      try {
        fs.mkdirSync(path.join(this.tempDir, str), { recursive: true });
        sftpStream.status(reqid, 0);
      } catch {
        sftpStream.status(reqid, 4);
      }
    });

    sftpStream.on('REMOVE', (reqid: number, str: string) => {
      try {
        fs.unlinkSync(path.join(this.tempDir, str));
        sftpStream.status(reqid, 0);
      } catch {
        sftpStream.status(reqid, 4);
      }
    });

    sftpStream.on('RMDIR', (reqid: number, str: string) => {
      try {
        fs.rmdirSync(path.join(this.tempDir, str));
        sftpStream.status(reqid, 0);
      } catch {
        sftpStream.status(reqid, 4);
      }
    });
  }

  public async start(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      this.server.listen(this.port, this.host, () => {
        const addr = this.server.address() as net.AddressInfo;
        this.port = addr.port;
        resolve(this.port);
      });
      this.server.on('error', reject);
    });
  }

  public async stop(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.server.close(() => {
        try {
          fs.rmSync(this.tempDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
        resolve();
      });
    });
  }
}
