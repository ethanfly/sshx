import { resolveTarget, ConnectCliOptions } from './connect.js';
import { SSHConnection } from '../core/client.js';
import { TunnelManager, parsePortForwardString } from '../core/tunnel.js';
import { colors, formatBytes, renderTable } from './utils.js';

export interface TunnelCliOptions extends ConnectCliOptions {
  localForward?: string[];
  remoteForward?: string[];
  dynamicForward?: string[];
}

export async function runTunnel(target: string, options: TunnelCliOptions = {}): Promise<void> {
  let profile;
  try {
    profile = resolveTarget(target, options);
  } catch (err: any) {
    process.stderr.write(`${colors.red}Error: ${err.message || String(err)}${colors.reset}\n`);
    process.exit(1);
  }
  const conn = new SSHConnection({ profile });

  if (!options.localForward && !options.remoteForward && !options.dynamicForward) {
    process.stderr.write(`${colors.red}Error: Please specify at least one tunnel (-L, -R, or -D)${colors.reset}\n`);
    process.exit(1);
  }

  try {
    process.stdout.write(`${colors.dim}Connecting to ${profile.host} for tunneling...${colors.reset}\n`);
    await conn.connect();
    process.stdout.write(`${colors.green}✓ Connected.${colors.reset}\n\n`);

    const tm = new TunnelManager(conn.getRawClient());

    if (options.localForward) {
      for (const spec of options.localForward) {
        const config = parsePortForwardString(spec, 'local');
        const tunnel = await tm.addTunnel(config);
        await tunnel.start();
      }
    }

    if (options.remoteForward) {
      for (const spec of options.remoteForward) {
        const config = parsePortForwardString(spec, 'remote');
        const tunnel = await tm.addTunnel(config);
        await tunnel.start();
      }
    }

    if (options.dynamicForward) {
      for (const spec of options.dynamicForward) {
        const config = parsePortForwardString(spec, 'dynamic');
        const tunnel = await tm.addTunnel(config);
        await tunnel.start();
      }
    }

    const printStatus = () => {
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
    };

    printStatus();
    process.stdout.write(`\n${colors.cyan}Tunnels active. Press Ctrl+C to stop.${colors.reset}\n`);

    const interval = setInterval(() => {
      // Periodically refresh stats if needed
    }, 5000);

    const onExit = async () => {
      clearInterval(interval);
      process.stdout.write(`\n${colors.dim}Stopping tunnels...${colors.reset}\n`);
      await tm.stopAll();
      conn.disconnect();
      process.exit(0);
    };

    process.on('SIGINT', onExit);
    process.on('SIGTERM', onExit);
  } catch (err: any) {
    conn.disconnect();
    process.stderr.write(`${colors.red}Tunnel error: ${err.message || String(err)}${colors.reset}\n`);
    process.exit(1);
  }
}
