import { resolveTarget, ConnectCliOptions } from './connect.js';
import { SSHConnection } from '../core/client.js';
import { HostProfile } from '../core/config.js';
import { execCommand } from '../core/exec.js';
import { colors } from './utils.js';

export interface ExecCliOptions extends ConnectCliOptions {
  json?: boolean;
  timeout?: string | number;
  env?: string[];
}

export async function runExec(
  target: string,
  command: string,
  options: ExecCliOptions = {}
): Promise<void> {
  let profile: HostProfile;
  try {
    profile = resolveTarget(target, options);
  } catch (err: any) {
    process.stderr.write(`${colors.red}Error: ${err.message || String(err)}${colors.reset}\n`);
    process.exit(1);
  }
  const connection = new SSHConnection({ profile });

  try {
    await connection.connect();

    const envMap: Record<string, string> = {};
    if (options.env) {
      for (const item of options.env) {
        const [k, v] = item.split('=');
        if (k && v !== undefined) envMap[k] = v;
      }
    }

    const timeoutMs = options.timeout ? Number(options.timeout) * 1000 : undefined;

    const result = await execCommand(connection.getRawClient(), command, {
      timeout: timeoutMs,
      env: Object.keys(envMap).length > 0 ? envMap : undefined
    });

    connection.disconnect();

    if (options.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } else {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    }

    process.exitCode = result.exitCode;
  } catch (err: any) {
    connection.disconnect();
    if (options.json) {
      process.stdout.write(JSON.stringify({ error: err.message || String(err), exitCode: 1 }, null, 2) + '\n');
    } else {
      process.stderr.write(`${colors.red}Exec error: ${err.message || String(err)}${colors.reset}\n`);
    }
    process.exitCode = 1;
  }
}
