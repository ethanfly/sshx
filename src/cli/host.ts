import fs from 'node:fs';
import path from 'node:path';
import { defaultConfigManager, HostProfile, resolvePortablePath } from '../core/config.js';
import { SSHConnection } from '../core/client.js';
import { colors, prompt, renderTable } from './utils.js';

export interface HostListCliOptions {
  json?: boolean;
  tag?: string;
  search?: string;
}

export async function runHostList(options: HostListCliOptions = {}): Promise<void> {
  let hosts = defaultConfigManager.getHosts();

  if (options.tag) {
    const filterTag = options.tag.toLowerCase();
    hosts = hosts.filter(h => (h.tags || []).some(t => t.toLowerCase() === filterTag));
  }

  if (options.search) {
    const q = options.search.toLowerCase();
    hosts = hosts.filter(h =>
      h.name.toLowerCase().includes(q) ||
      h.host.toLowerCase().includes(q) ||
      h.username.toLowerCase().includes(q) ||
      (h.notes && h.notes.toLowerCase().includes(q)) ||
      (h.tags && h.tags.some(t => t.toLowerCase().includes(q)))
    );
  }

  if (options.json) {
    process.stdout.write(JSON.stringify(hosts, null, 2) + '\n');
    return;
  }

  if (hosts.length === 0) {
    process.stdout.write(`${colors.dim}No saved hosts found matching your criteria. Use 'sshx host add' or 'sshx host import-ssh-config' to add one.${colors.reset}\n`);
    return;
  }

  const rows = hosts.map(h => [
    h.name,
    `${h.username}@${h.host}:${h.port}`,
    h.authType,
    (h.tags || []).join(', ') || '-',
    h.lastConnected ? new Date(h.lastConnected).toLocaleDateString() : 'Never'
  ]);

  process.stdout.write(renderTable(['Name', 'Address', 'Auth', 'Tags', 'Last Connected'], rows) + '\n');
}

export interface HostAddCliOptions extends Partial<HostProfile> {
  user?: string;
  yes?: boolean;
  force?: boolean;
  identity?: string;
}

export async function runHostAdd(options: HostAddCliOptions = {}): Promise<void> {
  const isInteractive = process.stdin.isTTY && !options.name && !options.host;

  let name = options.name;
  let host = options.host;
  let username = options.username || options.user;
  let port = options.port !== undefined ? Number(options.port) : undefined;
  let authType = options.authType;
  let password = options.password;
  let privateKeyPath = options.privateKeyPath || options.identity;
  let tags = options.tags;
  let notes = options.notes;

  if (isInteractive) {
    process.stdout.write(`${colors.bold}${colors.cyan}=== Add New SSH Host Profile ===${colors.reset}\n`);
    name = await prompt(`${colors.bold}Profile Name:${colors.reset} `);
    while (!name) {
      process.stdout.write(`${colors.red}Profile name is required.${colors.reset}\n`);
      name = await prompt(`${colors.bold}Profile Name:${colors.reset} `);
    }

    host = await prompt(`${colors.bold}Hostname or IP:${colors.reset} `);
    while (!host) {
      process.stdout.write(`${colors.red}Hostname or IP is required.${colors.reset}\n`);
      host = await prompt(`${colors.bold}Hostname or IP:${colors.reset} `);
    }

    const userAns = await prompt(`${colors.bold}Username (default: root):${colors.reset} `);
    username = userAns.trim() || 'root';

    const portAns = await prompt(`${colors.bold}Port (default: 22):${colors.reset} `);
    port = parseInt(portAns, 10) || 22;

    const authChoice = await prompt(`${colors.bold}Auth method [1=Key, 2=Password] (default: 1):${colors.reset} `);
    authType = authChoice.trim() === '2' ? 'password' : 'privateKey';

    if (authType === 'password') {
      password = await prompt(`${colors.bold}Password:${colors.reset} `, true);
    } else {
      const keyAns = await prompt(`${colors.bold}Private key path (default: ~/.ssh/id_ed25519):${colors.reset} `);
      privateKeyPath = keyAns.trim() || '~/.ssh/id_ed25519';
    }

    const tagsAns = await prompt(`${colors.bold}Tags (comma separated, e.g. prod,aws):${colors.reset} `);
    tags = tagsAns.split(',').map(s => s.trim()).filter(Boolean);

    const notesAns = await prompt(`${colors.bold}Notes (optional):${colors.reset} `);
    notes = notesAns.trim() || undefined;
  } else {
    // Non-interactive fallback
    if (!name || !host) {
      process.stderr.write(`${colors.red}Error: Both --name and --host must be specified.${colors.reset}\n`);
      process.exit(1);
    }
    username = username || 'root';
    port = port !== undefined ? Number(port) : 22;
    authType = authType || (password ? 'password' : (privateKeyPath ? 'privateKey' : 'password'));
  }

  // Check if profile with same name already exists
  const existing = defaultConfigManager.getHost(name);
  if (existing && !options.force && isInteractive) {
    const overwrite = await prompt(`${colors.yellow}Host '${name}' already exists. Overwrite? [y/N]: ${colors.reset}`);
    if (overwrite.toLowerCase() !== 'y' && overwrite.toLowerCase() !== 'yes') {
      process.stdout.write(`${colors.dim}Operation cancelled.${colors.reset}\n`);
      return;
    }
  }

  const newProfile = defaultConfigManager.addHost({
    name,
    host,
    username,
    port,
    authType,
    password,
    privateKeyPath,
    tags: tags || [],
    notes
  });

  process.stdout.write(`${colors.green}✓ Saved host profile '${newProfile.name}' (${newProfile.id})${colors.reset}\n`);
}

export interface HostEditCliOptions extends Partial<HostProfile> {
  user?: string;
  identity?: string;
  jump?: string;
}

export function printHostNotFound(idOrName: string): void {
  process.stderr.write(`${colors.red}Error: Host profile '${idOrName}' not found.${colors.reset}\n`);
  const suggestions = defaultConfigManager.suggestHosts(idOrName);
  if (suggestions.length > 0) {
    process.stderr.write(`\n${colors.yellow}Did you mean one of these?${colors.reset}\n`);
    for (const s of suggestions) {
      process.stderr.write(`  ${colors.cyan}• ${s.name}${colors.reset} (${s.username}@${s.host}:${s.port})\n`);
    }
  }
  const all = defaultConfigManager.getHosts();
  if (all.length > 0) {
    process.stderr.write(`\nRun '${colors.bold}sshx host list${colors.reset}' to view all saved host profiles.\n`);
  }
}

export async function runHostEdit(idOrName: string, options: HostEditCliOptions = {}): Promise<void> {
  const current = defaultConfigManager.getHost(idOrName);
  if (!current) {
    printHostNotFound(idOrName);
    process.exit(1);
  }

  const hasFlags = options.name !== undefined ||
    options.host !== undefined ||
    options.port !== undefined ||
    options.username !== undefined ||
    options.user !== undefined ||
    options.authType !== undefined ||
    options.password !== undefined ||
    options.privateKeyPath !== undefined ||
    options.identity !== undefined ||
    options.tags !== undefined ||
    options.notes !== undefined ||
    options.jump !== undefined;

  let updates: Partial<HostProfile> = {};

  if (hasFlags) {
    if (options.name !== undefined) updates.name = options.name;
    if (options.host !== undefined) updates.host = options.host;
    if (options.port !== undefined) updates.port = Number(options.port);
    if (options.username !== undefined || options.user !== undefined) updates.username = options.username || options.user;
    if (options.authType !== undefined) updates.authType = options.authType;
    if (options.password !== undefined) updates.password = options.password;
    if (options.privateKeyPath !== undefined) updates.privateKeyPath = options.privateKeyPath;
    if (options.identity !== undefined) updates.privateKeyPath = options.identity;
    if (options.tags !== undefined) updates.tags = options.tags;
    if (options.notes !== undefined) updates.notes = options.notes;
    if (options.jump !== undefined) updates.proxyJump = options.jump;
  } else if (process.stdin.isTTY) {
    // Interactive edit wizard
    process.stdout.write(`${colors.bold}${colors.cyan}=== Edit Host Profile: ${current.name} ===${colors.reset}\n`);
    process.stdout.write(`${colors.dim}Press Enter to keep current value.${colors.reset}\n\n`);

    const nameAns = await prompt(`${colors.bold}Profile Name [${current.name}]:${colors.reset} `);
    if (nameAns.trim()) updates.name = nameAns.trim();

    const hostAns = await prompt(`${colors.bold}Hostname or IP [${current.host}]:${colors.reset} `);
    if (hostAns.trim()) updates.host = hostAns.trim();

    const userAns = await prompt(`${colors.bold}Username [${current.username}]:${colors.reset} `);
    if (userAns.trim()) updates.username = userAns.trim();

    const portAns = await prompt(`${colors.bold}Port [${current.port}]:${colors.reset} `);
    if (portAns.trim()) updates.port = parseInt(portAns.trim(), 10) || current.port;

    const authChoice = await prompt(`${colors.bold}Auth method [1=Key, 2=Password] [current: ${current.authType}]:${colors.reset} `);
    if (authChoice.trim() === '1') {
      updates.authType = 'privateKey';
      const keyAns = await prompt(`${colors.bold}Private key path [${current.privateKeyPath || '~/.ssh/id_ed25519'}]:${colors.reset} `);
      updates.privateKeyPath = keyAns.trim() || current.privateKeyPath || '~/.ssh/id_ed25519';
    } else if (authChoice.trim() === '2') {
      updates.authType = 'password';
      const passAns = await prompt(`${colors.bold}New Password (leave empty to keep):${colors.reset} `, true);
      if (passAns) updates.password = passAns;
    }

    const currentTags = (current.tags || []).join(', ');
    const tagsAns = await prompt(`${colors.bold}Tags [${currentTags || 'none'}]:${colors.reset} `);
    if (tagsAns.trim()) {
      updates.tags = tagsAns.split(',').map(s => s.trim()).filter(Boolean);
    }

    const notesAns = await prompt(`${colors.bold}Notes [${current.notes || 'none'}]:${colors.reset} `);
    if (notesAns.trim()) updates.notes = notesAns.trim();
  }

  const updated = defaultConfigManager.updateHost(current.id, updates);
  if (updated) {
    process.stdout.write(`${colors.green}✓ Successfully updated host profile '${updated.name}' (${updated.id})${colors.reset}\n`);
  } else {
    process.stderr.write(`${colors.red}Failed to update host profile.${colors.reset}\n`);
    process.exit(1);
  }
}

export async function runHostRemove(idOrName: string, options: { force?: boolean; yes?: boolean } = {}): Promise<void> {
  const profile = defaultConfigManager.getHost(idOrName);
  if (!profile) {
    printHostNotFound(idOrName);
    process.exit(1);
  }

  const skipConfirm = options.force || options.yes;
  if (!skipConfirm && process.stdin.isTTY) {
    const confirm = await prompt(`${colors.yellow}Are you sure you want to remove host '${profile.name}' (${profile.username}@${profile.host})? [y/N]: ${colors.reset}`);
    if (confirm.toLowerCase() !== 'y' && confirm.toLowerCase() !== 'yes') {
      process.stdout.write(`${colors.dim}Operation cancelled.${colors.reset}\n`);
      return;
    }
  }

  const success = defaultConfigManager.deleteHost(profile.id);
  if (success) {
    process.stdout.write(`${colors.green}✓ Removed host profile '${profile.name}'${colors.reset}\n`);
  } else {
    process.stderr.write(`${colors.red}Failed to remove host profile '${idOrName}'.${colors.reset}\n`);
    process.exit(1);
  }
}

export async function runHostShow(idOrName: string, options: { json?: boolean } = {}): Promise<void> {
  const profile = defaultConfigManager.getHost(idOrName);
  if (!profile) {
    printHostNotFound(idOrName);
    process.exit(1);
  }

  if (options.json) {
    process.stdout.write(JSON.stringify(profile, null, 2) + '\n');
    return;
  }

  process.stdout.write(`\n${colors.bold}${colors.cyan}Host Profile Details: ${profile.name}${colors.reset}\n`);
  process.stdout.write(`${'─'.repeat(45)}\n`);
  process.stdout.write(`  ${colors.bold}ID:${colors.reset}             ${profile.id}\n`);
  process.stdout.write(`  ${colors.bold}Name:${colors.reset}           ${profile.name}\n`);
  process.stdout.write(`  ${colors.bold}Address:${colors.reset}        ${profile.username}@${profile.host}:${profile.port}\n`);
  process.stdout.write(`  ${colors.bold}Auth Method:${colors.reset}    ${profile.authType}\n`);
  if (profile.privateKeyPath) {
    const resolved = resolvePortablePath(profile.privateKeyPath, defaultConfigManager.getConfigDir());
    process.stdout.write(`  ${colors.bold}Key Path:${colors.reset}       ${profile.privateKeyPath}\n`);
    if (resolved !== profile.privateKeyPath) {
      process.stdout.write(`  ${colors.bold}Key (Resolved):${colors.reset} ${resolved}\n`);
    }
  }
  if (profile.proxyJump) {
    process.stdout.write(`  ${colors.bold}Jump Host:${colors.reset}      ${profile.proxyJump}\n`);
  }
  if (profile.proxyCommand) {
    process.stdout.write(`  ${colors.bold}ProxyCommand:${colors.reset}   ${profile.proxyCommand}\n`);
  }
  process.stdout.write(`  ${colors.bold}Tags:${colors.reset}           ${(profile.tags || []).join(', ') || '-'}\n`);
  if (profile.notes) {
    process.stdout.write(`  ${colors.bold}Notes:${colors.reset}          ${profile.notes}\n`);
  }
  process.stdout.write(`  ${colors.bold}Last Connected:${colors.reset} ${profile.lastConnected ? new Date(profile.lastConnected).toLocaleString() : 'Never'}\n\n`);
}

export async function runHostExport(filePath?: string): Promise<void> {
  const jsonStr = defaultConfigManager.exportHosts(filePath);
  if (filePath) {
    process.stdout.write(`${colors.green}✓ Successfully exported host profiles to '${filePath}'.${colors.reset}\n`);
  } else {
    process.stdout.write(jsonStr + '\n');
  }
}

export async function runHostImport(filePath: string, options: { overwrite?: boolean } = {}): Promise<void> {
  try {
    const res = defaultConfigManager.importHosts(filePath, options.overwrite ? 'overwrite' : 'merge');
    process.stdout.write(`${colors.green}✓ Successfully imported hosts: ${res.imported} new, ${res.updated} updated (Total: ${res.total})${colors.reset}\n`);
  } catch (err: any) {
    process.stderr.write(`${colors.red}Import failed: ${err.message || String(err)}${colors.reset}\n`);
    process.exit(1);
  }
}

export async function runHostTest(idOrName: string): Promise<void> {
  const profile = defaultConfigManager.getHost(idOrName);
  if (!profile) {
    printHostNotFound(idOrName);
    process.exit(1);
  }

  process.stdout.write(`Testing connection to ${profile.name} (${profile.username}@${profile.host}:${profile.port})...\n`);
  const res = await SSHConnection.testLatency(profile);

  if (res.success) {
    process.stdout.write(`${colors.green}✓ Connection successful! Latency: ${res.latencyMs}ms${colors.reset}\n`);
  } else {
    process.stderr.write(`${colors.red}✗ Connection failed: ${res.error}${colors.reset}\n`);
    process.exit(1);
  }
}

export async function runHostImportSshConfig(customPath?: string): Promise<void> {
  process.stdout.write(`Importing OpenSSH configuration...\n`);
  const imported = defaultConfigManager.importOpenSSHConfig(customPath);
  process.stdout.write(`${colors.green}✓ Successfully imported ${imported.length} host profiles.${colors.reset}\n`);
  for (const h of imported) {
    process.stdout.write(`  - ${h.name} (${h.username}@${h.host}:${h.port})\n`);
  }
}
