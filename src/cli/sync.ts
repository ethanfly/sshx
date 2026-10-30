import { Command } from 'commander';
import { defaultSyncManager, SyncConfig } from '../sync/manager.js';
import { WebDavProvider, GistProvider } from '../sync/provider.js';
import { colors, prompt } from './utils.js';

export function registerSyncCommand(program: Command): void {
  const syncCmd = program
    .command('sync')
    .description('End-to-end encrypted synchronization for host profiles (WebDAV / GitHub Gist)')
    .action(async () => {
      const status = await defaultSyncManager.getStatus();
      if (!status.configured) {
        process.stdout.write(`${colors.yellow}Cloud sync is not configured yet.${colors.reset}\n`);
        process.stdout.write(`Starting interactive setup wizard...\n\n`);
        await runSyncSetup();
        return;
      }

      process.stdout.write(`${colors.bold}sshx Cloud Sync${colors.reset}\n`);
      process.stdout.write(`Provider:   ${colors.cyan}${status.provider}${colors.reset}\n`);
      process.stdout.write(`Last sync:  ${status.lastSync || 'Never'}\n`);
      process.stdout.write(`Hosts:      ${status.localHostsCount} local profile(s)\n\n`);

      const choice = await prompt(`Choose action [${colors.cyan}push${colors.reset}/${colors.cyan}pull${colors.reset}/${colors.cyan}status${colors.reset}/${colors.cyan}setup${colors.reset}]: `);
      const action = choice.trim().toLowerCase();

      if (action === 'push') {
        await runSyncPush();
      } else if (action === 'pull') {
        await runSyncPull();
      } else if (action === 'setup') {
        await runSyncSetup();
      } else {
        await runSyncStatus();
      }
    });

  syncCmd
    .command('setup')
    .description('Configure cloud sync provider (WebDAV or GitHub Gist)')
    .option('-p, --provider <type>', 'Provider type: "webdav" or "gist"')
    .option('--url <url>', 'WebDAV base URL (e.g. https://dav.jianguoyun.com/dav/sshx/)')
    .option('-u, --username <username>', 'WebDAV username')
    .option('--password <password>', 'WebDAV password or app token')
    .option('--token <token>', 'GitHub Personal Access Token')
    .option('--gist-id <gistId>', 'Existing Gist ID (optional)')
    .option('--passphrase <passphrase>', 'E2EE master passphrase')
    .action(async (opts) => {
      await runSyncSetup(opts);
    });

  syncCmd
    .command('push')
    .description('Encrypt and upload host profiles to cloud provider')
    .option('--passphrase <passphrase>', 'Master passphrase for decryption')
    .action(async (opts) => {
      await runSyncPush(opts.passphrase);
    });

  syncCmd
    .command('pull')
    .description('Download, decrypt and merge host profiles from cloud provider')
    .option('--passphrase <passphrase>', 'Master passphrase for decryption')
    .option('--overwrite', 'Overwrite local profiles instead of merging', false)
    .action(async (opts) => {
      await runSyncPull(opts.passphrase, opts.overwrite ? 'overwrite' : 'merge');
    });

  syncCmd
    .command('status')
    .description('Check sync status and verify cloud connectivity')
    .action(async () => {
      await runSyncStatus();
    });
}

export async function runSyncSetup(options: {
  provider?: string;
  url?: string;
  username?: string;
  password?: string;
  token?: string;
  gistId?: string;
  passphrase?: string;
} = {}): Promise<void> {
  process.stdout.write(`\n${colors.bold}${colors.cyan}=== sshx Sync Setup (E2EE) ===${colors.reset}\n`);
  process.stdout.write(`${colors.dim}Your hosts configuration (including stored passwords & keys) will be encrypted client-side with AES-256-GCM before uploading.${colors.reset}\n\n`);

  let providerType = options.provider?.toLowerCase();
  if (!providerType || (providerType !== 'webdav' && providerType !== 'gist')) {
    process.stdout.write(`Supported providers:\n`);
    process.stdout.write(`  1) ${colors.bold}WebDAV${colors.reset} (Jianguoyun / 坚果云, Nextcloud, Synology NAS, Alist, etc.)\n`);
    process.stdout.write(`  2) ${colors.bold}GitHub Gist${colors.reset} (Private secret Gist via Personal Access Token)\n\n`);
    const ans = await prompt(`Choose provider [1 for webdav, 2 for gist]: `);
    providerType = ans.trim() === '2' || ans.trim().toLowerCase() === 'gist' ? 'gist' : 'webdav';
  }

  const syncConfig: SyncConfig = {
    provider: providerType as 'webdav' | 'gist'
  };

  if (providerType === 'webdav') {
    let url = options.url || (await prompt(`WebDAV URL [e.g. https://dav.jianguoyun.com/dav/sshx/]: `));
    let username = options.username || (await prompt(`WebDAV Username: `));
    let password = options.password || (await prompt(`WebDAV Password or App Token: `, true));

    syncConfig.webdav = {
      url: url.trim(),
      username: username.trim(),
      password: password.trim()
    };

    process.stdout.write(`\nTesting WebDAV connection... `);
    const provider = new WebDavProvider(syncConfig.webdav);
    const testRes = await provider.test();
    if (testRes.ok) {
      process.stdout.write(`${colors.green}✓ ${testRes.message}${colors.reset}\n`);
    } else {
      process.stdout.write(`${colors.yellow}⚠ Warning: ${testRes.message}${colors.reset}\n`);
    }
  } else {
    let token = options.token || (await prompt(`GitHub Personal Access Token: `, true));
    let gistId = options.gistId || (await prompt(`Existing Gist ID (leave blank to auto-create): `));

    syncConfig.gist = {
      token: token.trim(),
      gistId: gistId.trim() || undefined
    };

    process.stdout.write(`\nTesting GitHub connection... `);
    const provider = new GistProvider(syncConfig.gist);
    const testRes = await provider.test();
    if (testRes.ok) {
      process.stdout.write(`${colors.green}✓ ${testRes.message}${colors.reset}\n`);
    } else {
      process.stdout.write(`${colors.yellow}⚠ Warning: ${testRes.message}${colors.reset}\n`);
    }
  }

  // Master Passphrase setup
  process.stdout.write(`\n${colors.bold}Master Passphrase Setup${colors.reset}\n`);
  process.stdout.write(`${colors.dim}This passphrase encrypts and decrypts your host profiles. Keep it safe!${colors.reset}\n`);

  let passphrase = options.passphrase;
  if (!passphrase) {
    while (!passphrase || passphrase.length < 4) {
      passphrase = await prompt(`Enter Master Passphrase (min 4 characters): `, true);
      if (passphrase.length < 4) {
        process.stdout.write(`${colors.red}Passphrase too short. Please try again.${colors.reset}\n`);
      }
    }
    const confirm = await prompt(`Confirm Master Passphrase: `, true);
    if (passphrase !== confirm) {
      process.stderr.write(`${colors.red}Passphrase confirmation did not match. Setup aborted.${colors.reset}\n`);
      return;
    }
  }

  const savePass = await prompt(`Save passphrase locally in ~/.config/sshx/sync.json? [Y/n]: `);
  if (savePass.trim().toLowerCase() !== 'n') {
    syncConfig.passphrase = passphrase;
    syncConfig.savePassphrase = true;
  } else {
    syncConfig.savePassphrase = false;
  }

  defaultSyncManager.saveConfig(syncConfig);
  process.stdout.write(`\n${colors.green}✓ Sync configuration saved successfully!${colors.reset}\n`);
  process.stdout.write(`Run '${colors.cyan}sshx sync push${colors.reset}' to upload your hosts now, or '${colors.cyan}sshx sync pull${colors.reset}' on your other machines.\n\n`);
}

export async function runSyncPush(passphrase?: string): Promise<void> {
  const config = defaultSyncManager.getConfig();
  if (!config) {
    process.stderr.write(`${colors.red}Sync is not configured. Run "sshx sync setup" first.${colors.reset}\n`);
    process.exit(1);
  }

  let pass = passphrase || config.passphrase;
  if (!pass) {
    pass = await prompt(`Enter Master Passphrase: `, true);
  }

  process.stdout.write(`${colors.dim}Encrypting with AES-256-GCM and uploading to ${config.provider}...${colors.reset}\n`);
  try {
    const res = await defaultSyncManager.push(pass);
    process.stdout.write(`${colors.green}✓ Successfully synced ${res.count} host profile(s) to ${config.provider}.${colors.reset}\n`);
    if (res.remoteId) {
      process.stdout.write(`${colors.dim}Remote ID/URL: ${res.remoteId}${colors.reset}\n`);
    }
    process.stdout.write(`${colors.dim}Timestamp: ${res.updatedAt}${colors.reset}\n`);
  } catch (err: any) {
    process.stderr.write(`${colors.red}Sync push failed: ${err.message || String(err)}${colors.reset}\n`);
    process.exit(1);
  }
}

export async function runSyncPull(passphrase?: string, mode: 'merge' | 'overwrite' = 'merge'): Promise<void> {
  const config = defaultSyncManager.getConfig();
  if (!config) {
    process.stderr.write(`${colors.red}Sync is not configured. Run "sshx sync setup" first.${colors.reset}\n`);
    process.exit(1);
  }

  let pass = passphrase || config.passphrase;
  if (!pass) {
    pass = await prompt(`Enter Master Passphrase: `, true);
  }

  process.stdout.write(`${colors.dim}Downloading and decrypting from ${config.provider}...${colors.reset}\n`);
  try {
    const res = await defaultSyncManager.pull(pass, mode);
    process.stdout.write(`${colors.green}✓ Sync pull successful!${colors.reset}\n`);
    process.stdout.write(`  • Imported: ${colors.bold}${res.imported}${colors.reset}\n`);
    process.stdout.write(`  • Updated:  ${colors.bold}${res.updated}${colors.reset}\n`);
    process.stdout.write(`  • Total:    ${colors.bold}${res.total}${colors.reset} host profile(s)\n`);
    if (res.remoteUpdatedAt) {
      process.stdout.write(`${colors.dim}Remote timestamp: ${res.remoteUpdatedAt}${colors.reset}\n`);
    }
  } catch (err: any) {
    process.stderr.write(`${colors.red}Sync pull failed: ${err.message || String(err)}${colors.reset}\n`);
    process.exit(1);
  }
}

export async function runSyncStatus(): Promise<void> {
  const status = await defaultSyncManager.getStatus();
  process.stdout.write(`\n${colors.bold}=== sshx Sync Status ===${colors.reset}\n`);
  if (!status.configured) {
    process.stdout.write(`Status:     ${colors.yellow}Not Configured${colors.reset}\n`);
    process.stdout.write(`Hosts:      ${status.localHostsCount} local profile(s)\n`);
    process.stdout.write(`\nRun '${colors.cyan}sshx sync setup${colors.reset}' to enable end-to-end encrypted cloud sync.\n\n`);
    return;
  }

  process.stdout.write(`Status:     ${colors.green}Configured${colors.reset}\n`);
  process.stdout.write(`Provider:   ${colors.cyan}${status.provider}${colors.reset}\n`);
  process.stdout.write(`Last Sync:  ${status.lastSync ? new Date(status.lastSync).toLocaleString() : 'Never'}\n`);
  process.stdout.write(`Hosts:      ${status.localHostsCount} local profile(s)\n`);

  if (status.connectivity) {
    const connStr = status.connectivity.ok
      ? `${colors.green}✓ ${status.connectivity.message}${colors.reset}`
      : `${colors.red}✗ ${status.connectivity.message}${colors.reset}`;
    process.stdout.write(`Remote:     ${connStr}\n`);
  }
  process.stdout.write('\n');
}
