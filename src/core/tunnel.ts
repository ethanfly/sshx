import net from 'node:net';
import EventEmitter from 'node:events';
import { Client } from 'ssh2';

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

    if (this.config.type === 'remote' && this.config.remotePort) {
      await new Promise<void>((resolve) => {
        this.client.unforwardIn(this.config.remoteHost || '127.0.0.1', this.config.remotePort!, () => resolve());
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

    const onTcpConnection = (details: any, accept: () => any, reject: () => any) => {
      if (details.destPort !== remoteBindPort) return;

      const stream = accept();
      const localSocket = net.connect(localTargetPort, localTargetHost, () => {
        this.handleSocketConnection(localSocket);

        localSocket.on('data', (data) => {
          this.bytesOut += data.length;
        });
        stream.on('data', (data: Buffer) => {
          this.bytesIn += data.length;
        });

        stream.pipe(localSocket).pipe(stream);
      });

      localSocket.on('error', () => {
        try {
          stream.close();
        } catch {
          // ignore
        }
      });
    };

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
    let state: 'AUTH' | 'REQUEST' | 'STREAM' = 'AUTH';

    const onData = (chunk: Buffer) => {
      try {
        if (state === 'AUTH') {
          // Chunk: [VER: 1B, NMETHODS: 1B, METHODS: NB]
          if (chunk.length < 2 || chunk[0] !== 0x05) {
            socket.destroy();
            return;
          }
          // Reply: [VER: 0x05, METHOD: 0x00 (NO AUTH)]
          socket.write(Buffer.from([0x05, 0x00]));
          state = 'REQUEST';
        } else if (state === 'REQUEST') {
          // Chunk: [VER: 0x05, CMD: 1B, RSV: 0x00, ATYP: 1B, DST.ADDR, DST.PORT: 2B]
          if (chunk.length < 6 || chunk[0] !== 0x05) {
            socket.destroy();
            return;
          }

          const cmd = chunk[1]; // 0x01 = CONNECT
          if (cmd !== 0x01) {
            // Command not supported
            socket.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            socket.destroy();
            return;
          }

          const atyp = chunk[3];
          let targetHost = '';
          let offset = 4;

          if (atyp === 0x01) {
            // IPv4
            if (chunk.length < offset + 4 + 2) return socket.destroy();
            targetHost = `${chunk[offset]}.${chunk[offset + 1]}.${chunk[offset + 2]}.${chunk[offset + 3]}`;
            offset += 4;
          } else if (atyp === 0x03) {
            // Domain name
            const domainLen = chunk[offset++];
            if (chunk.length < offset + domainLen + 2) return socket.destroy();
            targetHost = chunk.subarray(offset, offset + domainLen).toString('utf8');
            offset += domainLen;
          } else if (atyp === 0x04) {
            // IPv6
            if (chunk.length < offset + 16 + 2) return socket.destroy();
            const parts: string[] = [];
            for (let i = 0; i < 16; i += 2) {
              parts.push(chunk.readUInt16BE(offset + i).toString(16));
            }
            targetHost = parts.join(':');
            offset += 16;
          } else {
            // Address type not supported
            socket.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            socket.destroy();
            return;
          }

          const targetPort = chunk.readUInt16BE(offset);
          socket.removeListener('data', onData);
          state = 'STREAM';

          // Forward connection through SSH client
          this.client.forwardOut(
            socket.remoteAddress || '127.0.0.1',
            socket.remotePort || 0,
            targetHost,
            targetPort,
            (err, stream) => {
              if (err) {
                // Connection refused
                socket.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
                socket.destroy();
                return;
              }

              // Send success response: [VER: 5, REP: 0, RSV: 0, ATYP: 1, BND.ADDR: 0.0.0.0, BND.PORT: 0]
              socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));

              socket.on('data', (d) => {
                this.bytesOut += d.length;
              });
              stream.on('data', (d: Buffer) => {
                this.bytesIn += d.length;
              });

              socket.pipe(stream).pipe(socket);
            }
          );
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
      this.activeSockets.delete(socket);
      this.activeConnections = Math.max(0, this.activeConnections - 1);
      this.emit('connection', { active: this.activeConnections, total: this.totalConnections });
    });

    socket.once('error', () => {
      this.activeSockets.delete(socket);
      this.activeConnections = Math.max(0, this.activeConnections - 1);
    });
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

  if (type === 'dynamic') {
    // Format: [bind_address:]port
    const parts = spec.split(':');
    if (parts.length === 1) {
      return { id, type, localHost: '127.0.0.1', localPort: parseInt(parts[0], 10) };
    } else {
      return { id, type, localHost: parts[0], localPort: parseInt(parts[1], 10) };
    }
  }

  // Format: [bind_address:]port:host:hostport
  const parts = spec.split(':');
  if (parts.length === 3) {
    return {
      id,
      type,
      localHost: '127.0.0.1',
      localPort: parseInt(parts[0], 10),
      remoteHost: parts[1],
      remotePort: parseInt(parts[2], 10)
    };
  } else if (parts.length === 4) {
    return {
      id,
      type,
      localHost: parts[0],
      localPort: parseInt(parts[1], 10),
      remoteHost: parts[2],
      remotePort: parseInt(parts[3], 10)
    };
  } else {
    throw new Error(`Invalid port forwarding specification: "${spec}". Expected "[bind_address:]port:host:hostport"`);
  }
}
