import { Command } from 'commander';
import { runConnect } from './connect.js';
import { runExec } from './exec.js';
import { runSftpLs, runSftpGet, runSftpPut, runSftpRm } from './sftp.js';
import { runTunnel } from './tunnel.js';
import {
  runHostList,
  runHostAdd,
  runHostEdit,
  runHostRemove,
  runHostShow,
  runHostExport,
  runHostImport,
  runHostTest,
  runHostImportSshConfig
} from './host.js';
import { runKeygen } from './keygen.js';
import { registerSyncCommand } from './sync.js';
import { startTUI, TuiOptions } from '../tui/index.js';
import { startMcpServer } from '../skill/mcp-server.js';
import { runSkillCli } from '../skill/runner.js';

export function createCli(): Command {
  const program = new Command();

  program
    .name('sshx')
    .description('Cross-platform SSH client with TUI launcher, CLI, and MCP host management')
    .version('1.0.0');

  // Direct connect fallback: sshx [target] or default to TUI
  program
    .argument('[target]', 'Target host or profile name to connect (if omitted, launches TUI)')
    .option('-s, --search <query>', 'Pre-fill the live search query in TUI mode')
    .option('--color <theme>', 'Color theme for TUI: default, dracula, nord, catppuccin')
    .option('--sort <mode>', 'Sort mode for TUI: name (default), none, fancy')
    .option('-p, --port <port>', 'SSH port (default: 22)')
    .option('-u, --user <username>', 'SSH username')
    .option('-i, --identity <path>', 'Private key identity file')
    .option('--password <password>', 'Password for authentication')
    .option('-J, --jump <jumphost>', 'Jump / Bastion host profile')
    .option('--record <file>', 'Record session to asciinema cast file')
    .option('-L, --local-forward <spec...>', 'Local port forwarding (e.g. 8080:localhost:80)')
    .option('-R, --remote-forward <spec...>', 'Remote port forwarding (e.g. 9000:localhost:3000)')
    .option('-D, --dynamic-forward <spec...>', 'Dynamic SOCKS5 port forwarding (e.g. 1080)')
    .option('--sidebar', 'Show server monitor sidebar on the right during session (default: auto when width >= 90)')
    .option('--no-sidebar', 'Disable server monitor sidebar')
    .action(async (target, options) => {
      if (target) {
        await runConnect(target, options);
      } else {
        const mode = String(options.sort || 'name');
        const sort = mode === 'fancy' || mode === 'none' ? mode : 'name';
        await startTUI({
          search: options.search,
          color: options.color,
          sort
        });
      }
    });

  // connect subcommand
  program
    .command('connect <target>')
    .description('Connect interactively to a host profile or address')
    .option('-p, --port <port>', 'SSH port')
    .option('-u, --user <username>', 'SSH username')
    .option('-i, --identity <path>', 'Private key identity file')
    .option('--password <password>', 'Password for authentication')
    .option('-J, --jump <jumphost>', 'Jump / Bastion host profile')
    .option('--record <file>', 'Record session to asciinema cast file')
    .option('-L, --local-forward <spec...>', 'Local port forwarding (e.g. 8080:localhost:80)')
    .option('-R, --remote-forward <spec...>', 'Remote port forwarding (e.g. 9000:localhost:3000)')
    .option('-D, --dynamic-forward <spec...>', 'Dynamic SOCKS5 port forwarding (e.g. 1080)')
    .option('--sidebar', 'Show server monitor sidebar on the right during session')
    .option('--no-sidebar', 'Disable server monitor sidebar')
    .action(async (target, options, command) => {
      await runConnect(target, command.optsWithGlobals());
    });

  // exec subcommand
  program
    .command('exec <target> <command>')
    .description('Execute a non-interactive command on remote host')
    .option('-p, --port <port>', 'SSH port')
    .option('-u, --user <username>', 'SSH username')
    .option('-i, --identity <path>', 'Private key identity file')
    .option('--password <password>', 'Password for authentication')
    .option('--json', 'Output result in JSON format')
    .option('--timeout <seconds>', 'Command timeout in seconds')
    .option('-e, --env <vars...>', 'Environment variables in KEY=VAL format')
    .action(async (target, cmd, options, command) => {
      await runExec(target, cmd, command.optsWithGlobals());
    });

  // sftp subcommand group
  const sftp = program.command('sftp').description('SFTP file operations');

  sftp
    .command('ls <target> [remotePath]')
    .description('List remote directory files')
    .option('-p, --port <port>', 'SSH port')
    .option('-u, --user <username>', 'SSH username')
    .option('-i, --identity <path>', 'Private key identity file')
    .option('--password <password>', 'Password for authentication')
    .action(async (target, remotePath, options, command) => {
      await runSftpLs(target, remotePath || '.', command.optsWithGlobals());
    });

  sftp
    .command('get <target> <remotePath> [localPath]')
    .description('Download file or directory from remote server')
    .option('-p, --port <port>', 'SSH port')
    .option('-u, --user <username>', 'SSH username')
    .option('-i, --identity <path>', 'Private key identity file')
    .option('--password <password>', 'Password for authentication')
    .action(async (target, remotePath, localPath, options, command) => {
      await runSftpGet(target, remotePath, localPath, command.optsWithGlobals());
    });

  sftp
    .command('put <target> <localPath> [remotePath]')
    .description('Upload file or directory to remote server')
    .option('-p, --port <port>', 'SSH port')
    .option('-u, --user <username>', 'SSH username')
    .option('-i, --identity <path>', 'Private key identity file')
    .option('--password <password>', 'Password for authentication')
    .action(async (target, localPath, remotePath, options, command) => {
      await runSftpPut(target, localPath, remotePath, command.optsWithGlobals());
    });

  sftp
    .command('rm <target> <remotePath>')
    .description('Delete remote file or directory')
    .option('-r, --recursive', 'Remove directories recursively')
    .option('-p, --port <port>', 'SSH port')
    .option('-u, --user <username>', 'SSH username')
    .option('-i, --identity <path>', 'Private key identity file')
    .option('--password <password>', 'Password for authentication')
    .action(async (target, remotePath, options, command) => {
      await runSftpRm(target, remotePath, command.optsWithGlobals());
    });

  // tunnel subcommand
  program
    .command('tunnel <target>')
    .description('Start SSH port forwarding tunnels')
    .option('-p, --port <port>', 'SSH port')
    .option('-u, --user <username>', 'SSH username')
    .option('-i, --identity <path>', 'Private key identity file')
    .option('--password <password>', 'Password for authentication')
    .option('-L, --local-forward <spec...>', 'Local port forwarding (e.g. 8080:localhost:80)')
    .option('-R, --remote-forward <spec...>', 'Remote port forwarding (e.g. 9000:localhost:3000)')
    .option('-D, --dynamic-forward <spec...>', 'Dynamic SOCKS5 port forwarding (e.g. 1080)')
    .action(async (target, options, command) => {
      await runTunnel(target, command.optsWithGlobals());
    });

  // hosts top-level shortcut
  program
    .command('ls')
    .description('List saved host profiles (shortcut for `sshx host list`)')
    .option('--json', 'Output profiles in JSON format')
    .option('-t, --tag <tag>', 'Filter by tag')
    .option('-s, --search <query>', 'Search by name, address, or tags')
    .action(async (options, command) => {
      await runHostList(command.optsWithGlobals());
    });

  program
    .command('hosts')
    .description('List saved host profiles (shortcut for `sshx host list`)')
    .option('--json', 'Output profiles in JSON format')
    .option('-t, --tag <tag>', 'Filter by tag')
    .option('-s, --search <query>', 'Search by name, address, or tags')
    .action(async (options, command) => {
      await runHostList(command.optsWithGlobals());
    });

  // host subcommand group
  const host = program.command('host').description('Manage saved SSH host profiles');

  host
    .command('list')
    .alias('ls')
    .description('List saved host profiles')
    .option('--json', 'Output profiles in JSON format')
    .option('-t, --tag <tag>', 'Filter by tag')
    .option('-s, --search <query>', 'Search by name, address, or tags')
    .action(async (options, command) => {
      await runHostList(command.optsWithGlobals());
    });

  host
    .command('add')
    .alias('new')
    .alias('create')
    .description('Add a new host profile (interactive or via flags)')
    .option('-n, --name <name>', 'Profile name')
    .option('-H, --host <host>', 'Hostname or IP')
    .option('-p, --port <port>', 'Port (default: 22)')
    .option('-u, --username <username>', 'Username (default: root)')
    .option('-a, --auth <type>', 'Auth method: key or password')
    .option('--auth-type <type>', 'Auth method: key or password')
    .option('--password <password>', 'Password')
    .option('-i, --identity <path>', 'Private key file')
    .option('-k, --key <path>', 'Private key file')
    .option('-J, --jump <jumphost>', 'Jump / Bastion host profile')
    .option('-t, --tags <tags...>', 'Tags for grouping')
    .option('--notes <notes>', 'Notes or description')
    .option('-f, --force', 'Force overwrite if host name exists')
    .option('-y, --yes', 'Confirm without prompt')
    .action(async (options, command) => {
      await runHostAdd(command.optsWithGlobals());
    });

  host
    .command('edit <idOrName>')
    .alias('update')
    .description('Edit an existing host profile')
    .option('-n, --name <name>', 'New profile name')
    .option('-H, --host <host>', 'New hostname or IP')
    .option('-p, --port <port>', 'New port')
    .option('-u, --username <username>', 'New username')
    .option('-a, --auth <type>', 'New auth method: key or password')
    .option('--auth-type <type>', 'New auth method: key or password')
    .option('--password <password>', 'New password')
    .option('-i, --identity <path>', 'New private key file')
    .option('-k, --key <path>', 'New private key file')
    .option('-J, --jump <jumphost>', 'Jump / Bastion host profile')
    .option('-t, --tags <tags...>', 'New tags')
    .option('--notes <notes>', 'New notes')
    .action(async (idOrName, options, command) => {
      await runHostEdit(idOrName, command.optsWithGlobals());
    });

  host
    .command('remove <idOrName>')
    .alias('rm')
    .alias('delete')
    .alias('del')
    .description('Remove a host profile')
    .option('-f, --force', 'Force removal without confirmation')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(async (idOrName, options, command) => {
      await runHostRemove(idOrName, command.optsWithGlobals());
    });

  host
    .command('show <idOrName>')
    .alias('info')
    .description('Show detailed information about a host profile')
    .option('--json', 'Output details in JSON format')
    .action(async (idOrName, options, command) => {
      await runHostShow(idOrName, command.optsWithGlobals());
    });

  host
    .command('export [file]')
    .description('Export host profiles to a portable JSON file or stdout')
    .action(async (file) => {
      await runHostExport(file);
    });

  host
    .command('import <file>')
    .description('Import host profiles from a JSON configuration file')
    .option('--overwrite', 'Overwrite existing host profiles instead of merging')
    .action(async (file, options, command) => {
      await runHostImport(file, command.optsWithGlobals());
    });

  host
    .command('test <idOrName>')
    .description('Test connectivity and measure latency to a host')
    .action(async (idOrName) => {
      await runHostTest(idOrName);
    });

  host
    .command('import-ssh-config [path]')
    .description('Import host configurations from OpenSSH ~/.ssh/config')
    .action(async (customPath) => {
      await runHostImportSshConfig(customPath);
    });

  // keygen subcommand
  program
    .command('keygen')
    .description('Generate a new SSH key pair (Ed25519 or RSA)')
    .option('-t, --type <type>', 'Key type: ed25519 or rsa (default: ed25519)')
    .option('-b, --bits <bits>', 'RSA modulus length in bits (2048, 3072, 4096)')
    .option('-f, --file <file>', 'Output key file path')
    .option('-C, --comment <comment>', 'Key comment (default: user@host)')
    .option('-N, --passphrase <passphrase>', 'Passphrase to encrypt private key')
    .action(async (options) => {
      await runKeygen(options);
    });

  // sync subcommand — E2EE cloud synchronization
  registerSyncCommand(program);

  // TUI subcommand — sshs-style launcher
  program
    .command('tui')
    .description('Launch the interactive host launcher (sshs-style TUI)')
    .option('-s, --search <query>', 'Pre-fill the live search query')
    .option('--color <theme>', 'Color theme: default, dracula, nord, catppuccin')
    .option('--sort <mode>', 'Sort mode: name (default), none, fancy', 'name')
    .action(async (options) => {
      const mode = String(options.sort || 'name');
      const sort = mode === 'fancy' || mode === 'none' ? mode : 'name';
      const tuiOptions: TuiOptions = {
        search: options.search,
        color: options.color,
        sort
      };
      await startTUI(tuiOptions);
    });

  // MCP / Skill subcommand
  program
    .command('mcp')
    .description('Start Model Context Protocol (MCP) server over stdio for AI integration')
    .action(async () => {
      await startMcpServer();
    });

  program
    .command('skill')
    .description('AI Agent skill runner and utilities')
    .argument('[subcommand]', 'Skill subcommand (e.g. exec, inspect, sftp-ls, hosts)')
    .argument('[args...]', 'Subcommand arguments')
    .action(async (subcommand, args) => {
      await runSkillCli(subcommand, args);
    });

  return program;
}

// Direct execution (when run directly via node dist/cli/index.js or tsx src/cli/index.ts)
const isDirectCli = process.argv[1] && (
  process.argv[1].endsWith('/cli/index.ts') ||
  process.argv[1].endsWith('/cli/index.js') ||
  process.argv[1].endsWith('cli/index.js')
);

if (isDirectCli) {
  const program = createCli();
  program.parseAsync(process.argv).catch((err) => {
    process.stderr.write(`Fatal error: ${err.message || String(err)}\n`);
    process.exit(1);
  });
}
