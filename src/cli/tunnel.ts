import { resolveTarget, prepareCliConnection, ConnectCliOptions } from './connect.js';
import { SSHConnection } from '../core/client.js';
import { TunnelManager, parsePortForwardString } from '../core/tunnel.js';
import { colors, formatBytes, renderTable } from './utils.js';
import { errorMessage } from '../core/errors.js';

export interface TunnelCliOptions extends ConnectCliOptions {
  localForward?: string[];
  remoteForward?: string[];
  dynamicForward?: string[];
}

export async function runTunnel(target: string, options: TunnelCliOptions = {}): Promise<void> {
  let profile;
  try {
    profile = resolveTarget(target, options);
  } catch (err) {
    process.stderr.write(`${colors.red}Error: ${errorMessage(err)}${colors.reset}\n`);
    process.exitCode = 1;
    return;
  }

  if (!options.localForward && !options.remoteForward && !options.dynamicForward) {
    process.stderr.write(`${colors.red}Error: Please specify at least one tunnel (-L, -R, or -D)${colors.reset}\n`);
    process.exitCode = 1;
    return;
  }

  const conn = new SSHConnection(await prepareCliConnection(profile));
  const client = conn.getRawClient();
  const tm = new TunnelManager(client);
  let userStopped = false;
  let transportClosed = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const onClose = () => {
    transportClosed = true;
    resolveClosed();
  };
  const onSignal = () => {
    if (userStopped || transportClosed) return;
    userStopped = true;
    process.stdout.write(`\n${colors.dim}Stopping tunnels...${colors.reset}\n`);
    conn.disconnect();
  };
  client.once('close', onClose);

  try {
    process.stdout.write(`${colors.dim}Connecting to ${profile.host} for tunneling...${colors.reset}\n`);
    await conn.connect();
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    process.stdout.write(`${colors.green}✓ Connected.${colors.reset}\n\n`);

    for (const [type, specs] of [
      ['local', options.localForward],
      ['remote', options.remoteForward],
      ['dynamic', options.dynamicForward]
    ] as const) {
      for (const spec of specs ?? []) {
        if (userStopped || transportClosed) break;
        const config = parsePortForwardString(spec, type);
        const tunnel = await tm.addTunnel(config);
        await tunnel.start();
      }
    }

    if (!userStopped && !transportClosed) {
      const tunnels = tm.getTunnels();
      const rows = tunnels.map(t => [
        t.id,
        t.type.toUpperCase(),
        t.localAddress,
        t.remoteTarget,
        t.status === 'running' ? `${colors.green}RUNNING${colors.reset}` : `${colors.red}STOPPED${colors.reset}`,
        String(t.activeConnections),
        `${formatBytes(t.bytesIn)} in / ${formatBytes(t.bytesOut)} out`
      ]);

      process.stdout.write(renderTable(['ID', 'Type', 'Local Bind', 'Remote Target', 'Status', 'Active Conns', 'Traffic'], rows) + '\n');
      process.stdout.write(`\n${colors.cyan}Tunnels active. Press Ctrl+C to stop.${colors.reset}\n`);
    }
    await closed;
    if (!userStopped) throw new Error('SSH connection closed unexpectedly');
  } catch (err) {
    if (!userStopped) {
      process.stderr.write(`${colors.red}Tunnel error: ${errorMessage(err)}${colors.reset}\n`);
      process.exitCode = 1;
    }
  } finally {
    conn.disconnect();
    try {
      await tm.stopAll();
    } finally {
      client.removeListener('close', onClose);
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    }
  }
}
