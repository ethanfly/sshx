import { SkillTools } from './tools.js';
import { colors } from '../cli/utils.js';

export async function runSkillCli(subcommand?: string, args: string[] = []): Promise<void> {
  if (!subcommand || subcommand === 'help') {
    printSkillHelp();
    return;
  }

  try {
    switch (subcommand) {
      case 'hosts': {
        const hosts = SkillTools.listHosts();
        process.stdout.write(JSON.stringify(hosts, null, 2) + '\n');
        break;
      }

      case 'exec': {
        const host = args[0];
        const cmd = args.slice(1).join(' ');
        if (!host || !cmd) {
          process.stderr.write(`${colors.red}Usage: sshx skill exec <host> "<command>"${colors.reset}\n`);
          process.exit(1);
        }
        const res = await SkillTools.exec(host, cmd);
        process.stdout.write(JSON.stringify(res, null, 2) + '\n');
        break;
      }

      case 'inspect': {
        const host = args[0];
        if (!host) {
          process.stderr.write(`${colors.red}Usage: sshx skill inspect <host>${colors.reset}\n`);
          process.exit(1);
        }
        const info = await SkillTools.getSystemInfo(host);
        process.stdout.write(JSON.stringify(info, null, 2) + '\n');
        break;
      }

      case 'sftp-ls': {
        const host = args[0];
        const remotePath = args[1] || '.';
        if (!host) {
          process.stderr.write(`${colors.red}Usage: sshx skill sftp-ls <host> [remotePath]${colors.reset}\n`);
          process.exit(1);
        }
        const files = await SkillTools.sftpList(host, remotePath);
        process.stdout.write(JSON.stringify(files, null, 2) + '\n');
        break;
      }

      case 'upload': {
        const host = args[0];
        const remotePath = args[1];
        const content = args.slice(2).join(' ');
        if (!host || !remotePath || !content) {
          process.stderr.write(`${colors.red}Usage: sshx skill upload <host> <remotePath> "<content>"${colors.reset}\n`);
          process.exit(1);
        }
        const res = await SkillTools.uploadFile(host, remotePath, { content });
        process.stdout.write(JSON.stringify(res, null, 2) + '\n');
        break;
      }

      case 'download': {
        const host = args[0];
        const remotePath = args[1];
        if (!host || !remotePath) {
          process.stderr.write(`${colors.red}Usage: sshx skill download <host> <remotePath>${colors.reset}\n`);
          process.exit(1);
        }
        const res = await SkillTools.downloadFile(host, remotePath);
        process.stdout.write(res.content || '');
        break;
      }

      default:
        process.stderr.write(`${colors.red}Unknown skill subcommand: "${subcommand}"${colors.reset}\n`);
        printSkillHelp();
        process.exit(1);
    }
  } catch (err: any) {
    process.stderr.write(JSON.stringify({ error: err.message || String(err) }, null, 2) + '\n');
    process.exit(1);
  }
}

function printSkillHelp(): void {
  process.stdout.write(`
${colors.bold}sshx AI Agent Skill Interface${colors.reset}

${colors.bold}Commands:${colors.reset}
  sshx skill hosts                          List saved host profiles
  sshx skill exec <host> "<cmd>"            Run remote command (returns JSON)
  sshx skill inspect <host>                 Inspect remote system specs (OS, CPU, RAM, Disk)
  sshx skill sftp-ls <host> [path]          List remote directory files
  sshx skill upload <host> <path> "<text>"  Upload text file to remote host
  sshx skill download <host> <path>         Download text file from remote host

${colors.bold}MCP Server for Claude Desktop / Claude Code:${colors.reset}
  sshx mcp                                  Start Model Context Protocol stdio server
\n`);
}
