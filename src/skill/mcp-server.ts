import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { SkillTools } from './tools.js';
import { packageVersion } from '../version.js';
import { errorMessage } from '../core/errors.js';

interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: true;
}

function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

function jsonResult(value: unknown): ToolResult {
  return textResult(JSON.stringify(value, null, 2));
}

function toolError(text: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text }] };
}

/** Reports a failing tool body as an MCP tool error so the agent can read and react to it. */
async function guarded(run: () => ToolResult | Promise<ToolResult>, failurePrefix?: string): Promise<ToolResult> {
  try {
    return await run();
  } catch (error) {
    const message = errorMessage(error);
    return toolError(failurePrefix ? `${failurePrefix}: ${message}` : message);
  }
}

const targetParam = z.string().describe('Host profile name/id or address [user@]hostname[:port]');

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'sshx-mcp-server',
    version: packageVersion
  });

  // Saved host profiles
  server.tool(
    'ssh_list_hosts',
    'List all saved SSH host profiles and their connection configurations',
    {},
    () => guarded(() => jsonResult(SkillTools.listHosts()))
  );

  server.tool(
    'ssh_add_host',
    'Add a new SSH host profile to saved configurations',
    {
      name: z.string().describe('Friendly name / alias for this host'),
      host: z.string().describe('Remote hostname or IP address'),
      port: z.number().optional().describe('SSH port (default 22)'),
      username: z.string().describe('SSH login username'),
      authType: z.enum(['password', 'privateKey', 'agent']).optional().describe('Authentication method'),
      password: z.string().optional().describe('Password if using password auth'),
      privateKeyPath: z.string().optional().describe('Path to private key file'),
      tags: z.array(z.string()).optional().describe('Tags / labels for grouping')
    },
    params => guarded(() => {
      const host = SkillTools.addHost(params);
      return textResult(`Successfully added host profile '${host.name}' (${host.id})\n` + JSON.stringify(host, null, 2));
    })
  );

  server.tool(
    'ssh_get_host',
    'Get one saved SSH host profile by id or name, including stored password and key path',
    {
      host: z.string().describe('Host profile id or name')
    },
    ({ host }) => guarded(() => {
      const profile = SkillTools.getHost(host);
      return profile ? jsonResult(profile) : toolError(`Host profile '${host}' not found`);
    })
  );

  server.tool(
    'ssh_update_host',
    'Update a saved SSH host profile (name, address, port, username, password, private key, tags, notes)',
    {
      host: z.string().describe('Existing host profile id or name'),
      name: z.string().optional().describe('New friendly name'),
      address: z.string().optional().describe('New hostname or IP'),
      port: z.number().optional().describe('New SSH port'),
      username: z.string().optional().describe('New SSH username'),
      authType: z.enum(['password', 'privateKey', 'agent']).optional().describe('Authentication method'),
      password: z.string().optional().describe('Password to store for password auth'),
      privateKeyPath: z.string().optional().describe('Path to private key file'),
      passphrase: z.string().optional().describe('Passphrase for an encrypted private key'),
      proxyJump: z.string().optional().describe('Jump host profile name or id'),
      tags: z.array(z.string()).optional().describe('Replacement tag list'),
      notes: z.string().optional().describe('Notes'),
      favorite: z.boolean().optional().describe('Pin this host to the top of fancy sort')
    },
    ({ host, address, ...rest }) => guarded(() => {
      const updated = SkillTools.updateHost(host, { ...rest, host: address });
      return textResult(`Updated host profile '${updated.name}' (${updated.id})\n` + JSON.stringify(updated, null, 2));
    })
  );

  server.tool(
    'ssh_delete_host',
    'Delete a saved SSH host profile by id or name',
    {
      host: z.string().describe('Host profile id or name to delete')
    },
    ({ host }) => guarded(() => textResult(`Deleted host profile '${SkillTools.deleteHost(host).name}'`))
  );

  // Local keys
  server.tool(
    'ssh_list_keys',
    'List local SSH private keys found in ~/.ssh and the sshx keys directory',
    {},
    () => guarded(() => jsonResult(SkillTools.listKeys()))
  );

  server.tool(
    'ssh_generate_key',
    'Generate a new Ed25519 or RSA SSH keypair',
    {
      type: z.enum(['ed25519', 'rsa']).optional().describe('Key algorithm (default ed25519)'),
      bits: z.number().optional().describe('RSA bits (2048, 3072, 4096)'),
      comment: z.string().optional().describe('Key comment')
    },
    ({ type, bits, comment }) => guarded(() => jsonResult(SkillTools.generateKey({ type, bits, comment })))
  );

  // Remote operations
  server.tool(
    'ssh_test_connection',
    'Test connectivity and measure latency to an SSH host',
    { host: targetParam },
    ({ host }) => guarded(async () => jsonResult(await SkillTools.testConnection(host)))
  );

  server.tool(
    'ssh_exec',
    'Execute a shell command on remote SSH server and return stdout, stderr, and exit code',
    {
      host: targetParam,
      command: z.string().describe('Shell command to execute'),
      timeout: z.number().optional().describe('Timeout in seconds (default 30)')
    },
    ({ host, command, timeout }) => guarded(
      async () => jsonResult(await SkillTools.exec(host, command, { timeout })),
      'Execution failed'
    )
  );

  server.tool(
    'ssh_sftp_list',
    'List files and directories in remote path via SFTP',
    {
      host: targetParam,
      path: z.string().optional().describe('Remote path to list (default ".")')
    },
    ({ host, path }) => guarded(async () => jsonResult(await SkillTools.sftpList(host, path || '.')), 'SFTP list failed')
  );

  server.tool(
    'ssh_upload_file',
    'Upload content or local file to remote destination path via SFTP',
    {
      host: targetParam,
      remotePath: z.string().describe('Destination file path on remote server'),
      content: z.string().optional().describe('Raw text content to write to remote file'),
      localPath: z.string().optional().describe('Path to local file to upload')
    },
    ({ host, remotePath, content, localPath }) => guarded(async () => {
      const res = await SkillTools.uploadFile(host, remotePath, { content, localPath });
      return textResult(`Successfully uploaded to ${res.path} (${res.size} bytes)`);
    }, 'SFTP upload failed')
  );

  server.tool(
    'ssh_download_file',
    'Download remote file to local path or return its text content',
    {
      host: targetParam,
      remotePath: z.string().describe('Source file path on remote server'),
      localPath: z.string().optional().describe('Local destination path (if omitted, content is returned)')
    },
    ({ host, remotePath, localPath }) => guarded(async () => {
      const res = await SkillTools.downloadFile(host, remotePath, localPath);
      return localPath
        ? textResult(`Successfully downloaded to ${res.localPath} (${res.size} bytes)`)
        : textResult(res.content || '');
    }, 'SFTP download failed')
  );

  server.tool(
    'ssh_system_info',
    'Inspect remote server hardware, OS, kernel, memory, disk, and uptime',
    { host: targetParam },
    ({ host }) => guarded(async () => jsonResult(await SkillTools.getSystemInfo(host)), 'System inspection failed')
  );

  return server;
}

export async function startMcpServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
