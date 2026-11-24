import net from 'node:net';
import EventEmitter from 'node:events';
import { Client, ClientChannel, TcpConnectionDetails, AcceptConnection, RejectConnection } from 'ssh2';

export type TunnelType = 'local' | 'remote' | 'dynamic';

export interface TunnelConfig {
  id: string;
  type: TunnelType;
  localHost?: string; // bind host locally (default 127.0.0.1)
  localPort: number;
  remoteHost?: string; // target host or remote bind host
  remotePort?: number; // target port or remote port
  description?: string;
}

export interface TunnelStats {
  id: string;
  type: TunnelType;
  status: 'running' | 'stopped' | 'error';
  localAddress: string;
  remoteTarget: string;
  activeConnections: number;
  totalConnections: number;
  bytesIn: number;
  bytesOut: number;
  startTime?: Date;
  error?: string;
}

export class Tunnel extends EventEmitter {
  public readonly config: TunnelConfig;
  private client: Client;
  private server?: net.Server;
  private status: 'running' | 'stopped' | 'error' = 'stopped';
  private activeConnections: number = 0;
  private totalConnections: number = 0;
  private bytesIn: number = 0;
  private bytesOut: number = 0;
  private startTime?: Date;
  private lastError?: string;
  private activeSockets: Set<net.Socket> = new Set();
  private remoteConnectionHandler?: (details: TcpConnectionDetails, accept: AcceptConnection<ClientChannel>, reject: RejectConnection) => void;

  constructor(client: Client, config: TunnelConfig) {
    super();
    this.client = client;
    this.config = {
      ...config,
      localHost: config.localHost || '127.0.0.1'
    };
  }

  public getStats(): TunnelStats {
    let remoteTarget = '';
    if (this.config.type === 'local') {
      remoteTarget = `${this.config.remoteHost}:${this.config.remotePort}`;
    } else if (this.config.type === 'remote') {
      remoteTarget = `remote:${this.config.remotePort} -> local:${this.config.localHost}:${this.config.localPort}`;
    } else if (this.config.type === 'dynamic') {
      remoteTarget = 'SOCKS5 Proxy';
    }

    return {
      id: this.config.id,
      type: this.config.type,
      status: this.status,
      localAddress: `${this.config.localHost}:${this.config.localPort}`,
      remoteTarget,
      activeConnections: this.activeConnections,
      totalConnections: this.totalConnections,
      bytesIn: this.bytesIn,
      bytesOut: this.bytesOut,
      startTime: this.startTime,
      error: this.lastError
    };
  }

  public isRunning(): boolean {
    return this.status === 'running';
  }

  /**
   * Start the tunnel
   */
  public async start(): Promise<void> {
    if (this.status === 'running') return;

    try {
      if (this.config.type === 'local') {
        await this.startLocalTunnel();
      } else if (this.config.type === 'remote') {
        await this.startRemoteTunnel();
      } else if (this.config.type === 'dynamic') {
        await this.startDynamicSocksTunnel();
      }
      this.status = 'running';
      this.startTime = new Date();
      this.lastError = undefined;
      this.emit('start', this.getStats());
    } catch (err: any) {
      this.status = 'error';
      this.lastError = err.message || String(err);
      this.emit('error', err);
      throw err;
    }
  }

  /**
   * Stop the tunnel and clean up all open sockets
   */
  public async stop(): Promise<void> {
    for (const socket of this.activeSockets) {
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    }
    this.activeSockets.clear();
    this.activeConnections = 0;

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server?.close(() => resolve());
      });
      this.server = undefined;
    }

    if (this.remoteConnectionHandler) {
      this.client.removeListener('tcp connection', this.remoteConnectionHandler);
      this.remoteConnectionHandler = undefined;
      await new Promise<void>((resolve) => {
        try {
          this.client.unforwardIn(this.config.remoteHost || '127.0.0.1', this.config.remotePort!, () => resolve());
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'Not connected') throw error;
          resolve();
        }
      });
    }

    this.status = 'stopped';
    this.emit('stop', this.getStats());
  }

  /**
   * Local Port Forwarding: listens on local port, forwards through SSH to remote target
   */
  private async startLocalTunnel(): Promise<void> {
    const bindHost = this.config.localHost || '127.0.0.1';
    const bindPort = this.config.localPort;
    const targetHost = this.config.remoteHost!;
    const targetPort = this.config.remotePort!;

    this.server = net.createServer((socket) => {
      this.handleSocketConnection(socket);

      this.client.forwardOut(
        socket.remoteAddress || '127.0.0.1',
        socket.remotePort || 0,
        targetHost,
        targetPort,
        (err, stream) => {
          if (err) {
            socket.destroy();
            return;
          }
          if (socket.destroyed) {
            stream.close();
            return;
          }

          stream.on('error', () => socket.destroy());
          stream.on('close', () => { if (!stream.readableEnded) socket.destroy(); });
          socket.on('close', () => stream.destroy());

          socket.on('data', (data) => {
            this.bytesOut += data.length;
          });
          stream.on('data', (data: Buffer) => {
            this.bytesIn += data.length;
          });

          socket.pipe(stream).pipe(socket);
        }
      );
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(bindPort, bindHost, () => {
        this.server!.removeListener('error', reject);
        resolve();
      });
    });
  }

  /**
   * Remote Port Forwarding: tells remote SSH server to listen on remotePort, forwards back locally
   */
  private async startRemoteTunnel(): Promise<void> {
    const remoteBindHost = this.config.remoteHost || '127.0.0.1';
    const remoteBindPort = this.config.remotePort!;
    const localTargetHost = this.config.localHost || '127.0.0.1';
    const localTargetPort = this.config.localPort;

    await new Promise<void>((resolve, reject) => {
      this.client.forwardIn(remoteBindHost, remoteBindPort, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });

    const onTcpConnection = (details: TcpConnectionDetails, accept: AcceptConnection<ClientChannel>) => {
      if (details.destPort !== remoteBindPort) return;

      const stream = accept();
      const localSocket = net.connect(localTargetPort, localTargetHost, () => {
        localSocket.on('data', (data) => {
          this.bytesOut += data.length;
        });
        stream.on('data', (data: Buffer) => {
          this.bytesIn += data.length;
        });

        stream.pipe(localSocket).pipe(stream);
      });

      this.handleSocketConnection(localSocket);
      stream.on('error', () => localSocket.destroy());
      stream.on('close', () => { if (!stream.readableEnded) localSocket.destroy(); });
      localSocket.on('close', () => stream.destroy());
      localSocket.on('error', () => {
        try {
          stream.close();
        } catch {
          // ignore
        }
      });
    };

    this.remoteConnectionHandler = onTcpConnection;
    this.client.on('tcp connection', onTcpConnection);
  }

  /**
   * Dynamic Port Forwarding (RFC 1928 SOCKS5 Proxy)
   */
  private async startDynamicSocksTunnel(): Promise<void> {
    const bindHost = this.config.localHost || '127.0.0.1';
    const bindPort = this.config.localPort;

    this.server = net.createServer((socket) => {
      this.handleSocketConnection(socket);
      this.handleSocks5Handshake(socket);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(bindPort, bindHost, () => {
        this.server!.removeListener('error', reject);
        resolve();
      });
    });
  }

  /**
   * SOCKS5 protocol handler
   */
  private handleSocks5Handshake(socket: net.Socket): void {
    let state: 'AUTH' | 'REQUEST' | 'CONNECTING' = 'AUTH';
    let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);

    const reject = (code: number) => {
      socket.end(Buffer.from([0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
    };

    const onData = (chunk: Buffer) => {
      try {
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        while (state !== 'CONNECTING') {
          if (state === 'AUTH') {
            if (pending.length < 2) return;
            if (pending[0] !== 0x05 || pending[1] === 0) {
              socket.destroy();
              return;
            }
            const length = 2 + pending[1];
            if (pending.length < length) return;
            const supportsNoAuth = pending.subarray(2, length).includes(0x00);
            pending = pending.subarray(length);
            if (!supportsNoAuth) {
              socket.end(Buffer.from([0x05, 0xff]));
              return;
            }
            socket.write(Buffer.from([0x05, 0x00]));
            state = 'REQUEST';
            continue;
          }

          if (pending.length < 4) return;
          if (pending[0] !== 0x05 || pending[2] !== 0x00) {
            socket.destroy();
            return;
          }

          if (pending[1] !== 0x01) {
            reject(0x07);
            return;
          }

          const atyp = pending[3];
          let targetHost = '';
          let offset = 4;

          if (atyp === 0x01) {
            if (pending.length < offset + 4 + 2) return;
            targetHost = `${pending[offset]}.${pending[offset + 1]}.${pending[offset + 2]}.${pending[offset + 3]}`;
            offset += 4;
          } else if (atyp === 0x03) {
            if (pending.length < offset + 1) return;
            const domainLen = pending[offset++];
            if (domainLen === 0) return socket.destroy();
            if (pending.length < offset + domainLen + 2) return;
            targetHost = pending.subarray(offset, offset + domainLen).toString('utf8');
            offset += domainLen;
          } else if (atyp === 0x04) {
            if (pending.length < offset + 16 + 2) return;
            const parts: string[] = [];
            for (let i = 0; i < 16; i += 2) {
              parts.push(pending.readUInt16BE(offset + i).toString(16));
            }
            targetHost = parts.join(':');
            offset += 16;
          } else {
            reject(0x08);
            return;
          }

          const targetPort = pending.readUInt16BE(offset);
          const initialData = pending.subarray(offset + 2);
          pending = Buffer.alloc(0);
          socket.removeListener('data', onData);
          socket.pause();
          state = 'CONNECTING';

          this.client.forwardOut(
            socket.remoteAddress || '127.0.0.1',
            socket.remotePort || 0,
            targetHost,
            targetPort,
            (err, stream) => {
              if (socket.destroyed) {
                stream?.close();
                return;
              }
              if (err) {
                reject(0x05);
                return;
              }

              stream.on('error', () => socket.destroy());
              stream.on('close', () => { if (!stream.readableEnded) socket.destroy(); });
              socket.on('close', () => stream.destroy());
              socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));

              socket.on('data', (d) => {
                this.bytesOut += d.length;
              });
              stream.on('data', (d: Buffer) => {
                this.bytesIn += d.length;
              });

              if (initialData.length) {
                this.bytesOut += initialData.length;
                stream.write(initialData);
              }
              socket.pipe(stream).pipe(socket);
              socket.resume();
            }
          );
          return;
        }
      } catch {
        socket.destroy();
      }
    };

    socket.on('data', onData);
  }

  private handleSocketConnection(socket: net.Socket): void {
    this.activeSockets.add(socket);
    this.activeConnections++;
    this.totalConnections++;
    this.emit('connection', { active: this.activeConnections, total: this.totalConnections });

    socket.once('close', () => {
      if (this.activeSockets.delete(socket)) {
        this.activeConnections--;
        this.emit('connection', { active: this.activeConnections, total: this.totalConnections });
      }
    });

    socket.once('error', () => socket.destroy());
  }
}

/**
 * Tunnel Manager: coordinates multiple active tunnels
 */
export class TunnelManager extends EventEmitter {
  private client: Client;
  private tunnels: Map<string, Tunnel> = new Map();

  constructor(client: Client) {
    super();
    this.client = client;
  }

  public getTunnels(): TunnelStats[] {
    return Array.from(this.tunnels.values()).map(t => t.getStats());
  }

  public getTunnel(id: string): Tunnel | undefined {
    return this.tunnels.get(id);
  }

  public async addTunnel(config: TunnelConfig): Promise<Tunnel> {
    if (this.tunnels.has(config.id)) {
      throw new Error(`Tunnel with id '${config.id}' already exists`);
    }

    const tunnel = new Tunnel(this.client, config);
    this.tunnels.set(config.id, tunnel);

    tunnel.on('start', (stats) => this.emit('tunnel:start', stats));
    tunnel.on('stop', (stats) => this.emit('tunnel:stop', stats));
    tunnel.on('error', (err) => this.emit('tunnel:error', { id: config.id, error: err }));

    return tunnel;
  }

  public async startTunnel(id: string): Promise<void> {
    const tunnel = this.tunnels.get(id);
    if (!tunnel) throw new Error(`Tunnel '${id}' not found`);
    await tunnel.start();
  }

  public async stopTunnel(id: string): Promise<void> {
    const tunnel = this.tunnels.get(id);
    if (!tunnel) throw new Error(`Tunnel '${id}' not found`);
    await tunnel.stop();
  }

  public async removeTunnel(id: string): Promise<void> {
    const tunnel = this.tunnels.get(id);
    if (tunnel) {
      await tunnel.stop();
      this.tunnels.delete(id);
    }
  }

  public async stopAll(): Promise<void> {
    for (const tunnel of this.tunnels.values()) {
      try {
        await tunnel.stop();
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Helper to parse SSH port forwarding string like "-L 8080:localhost:80" or "-L 127.0.0.1:8080:remote:80"
 */
export function parsePortForwardString(spec: string, type: 'local' | 'remote' | 'dynamic'): TunnelConfig {
  const id = `tunnel_${type}_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
  const invalid = () => new Error(`Invalid port forwarding specification: "${spec}". Expected "[bind_address:]port:host:hostport" (-L/-R) or "[bind_address:]port" (-D)`);
  const port = (value: string): number => {
    if (!/^\d+$/.test(value)) throw invalid();
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw invalid();
    return parsed;
  };

  if (type === 'dynamic') {
    const parts = spec.split(':');
    if (parts.length === 1) {
      return { id, type, localHost: '127.0.0.1', localPort: port(parts[0]) };
    }
    if (parts.length !== 2 || !parts[0]) throw invalid();
    return { id, type, localHost: parts[0], localPort: port(parts[1]) };
  }

  const parts = spec.split(':');
  if (parts.length !== 3 && parts.length !== 4) {
    throw invalid();
  }
  const [bindHost, bindPortText, targetHost, targetPortText] = parts.length === 4
    ? parts
    : ['127.0.0.1', ...parts];
  if (!bindHost || !targetHost) throw invalid();
  const bindPort = port(bindPortText);
  const targetPort = port(targetPortText);
  return type === 'local'
    ? { id, type, localHost: bindHost, localPort: bindPort, remoteHost: targetHost, remotePort: targetPort }
    : { id, type, localHost: targetHost, localPort: targetPort, remoteHost: bindHost, remotePort: bindPort };
}
