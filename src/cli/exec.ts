import { resolveTarget, ConnectCliOptions } from './connect.js';
import { SSHConnection } from '../core/client.js';
import { HostProfile } from '../core/config.js';
import { execCommand } from '../core/exec.js';
import { colors } from './utils.js';
import { errorMessage } from '../core/errors.js';

export interface ExecCliOptions extends ConnectCliOptions {
  json?: boolean;
  timeout?: string | number;
  maxOutputBytes?: string | number;
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
  } catch (err) {
    process.stderr.write(`${colors.red}Error: ${errorMessage(err)}${colors.reset}\n`);
    process.exit(1);
  }
  const connection = new SSHConnection({ profile });

  try {
    const envMap: Record<string, string> = Object.create(null);
    if (options.env) {
      for (const item of options.env) {
        const separator = item.indexOf('=');
        if (separator <= 0) throw new Error(`Expected KEY=VAL for --env: ${item}`);
        envMap[item.slice(0, separator)] = item.slice(separator + 1);
      }
    }

    const timeoutSeconds = options.timeout === undefined ? undefined : Number(options.timeout);
    if (timeoutSeconds !== undefined && (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds * 1000 > 2_147_483_647)) {
      throw new Error('--timeout must be between 0 and 2147483.647 seconds');
    }
    const timeoutMs = timeoutSeconds === undefined ? undefined : timeoutSeconds * 1000;
    const maxOutputBytes = options.maxOutputBytes === undefined ? undefined : Number(options.maxOutputBytes);
    if (maxOutputBytes !== undefined && (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0)) {
      throw new Error('--max-output-bytes must be a positive safe integer');
    }

    await connection.connect();

    const result = await execCommand(connection.getRawClient(), command, {
      timeout: timeoutMs,
      maxOutputBytes,
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
  } catch (err) {
    connection.disconnect();
    if (options.json) {
      process.stdout.write(JSON.stringify({ error: errorMessage(err), exitCode: 1 }, null, 2) + '\n');
    } else {
      process.stderr.write(`${colors.red}Exec error: ${errorMessage(err)}${colors.reset}\n`);
    }
    process.exitCode = 1;
  }
}
