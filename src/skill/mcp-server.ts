import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { SkillTools } from './tools.js';

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'sshx-mcp-server',
    version: '1.0.0'
  });

  // 1. List saved hosts
  server.tool(
    'ssh_list_hosts',
    'List all saved SSH host profiles and their connection configurations',
    {},
    async () => {
      const hosts = SkillTools.listHosts();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(hosts, null, 2)
          }
        ]
      };
    }
  );

  // 2. Add host profile
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
    async (params) => {
      const host = SkillTools.addHost(params);
      return {
        content: [
          {
            type: 'text',
            text: `Successfully added host profile '${host.name}' (${host.id})\n` + JSON.stringify(host, null, 2)
          }
        ]
      };
    }
  );

  // 3. Get one host
  server.tool(
    'ssh_get_host',
    'Get one saved SSH host profile by id or name, including stored password and key path',
    {
      host: z.string().describe('Host profile id or name')
    },
    async ({ host }) => {
      const profile = SkillTools.getHost(host);
      if (!profile) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Host profile '${host}' not found` }]
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(profile, null, 2) }]
      };
    }
  );

  // 4. Update host profile
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
    async ({ host, address, ...rest }) => {
      try {
        const updated = SkillTools.updateHost(host, {
          ...rest,
          host: address
        });
        return {
          content: [{
            type: 'text' as const,
            text: `Updated host profile '${updated.name}' (${updated.id})\n` + JSON.stringify(updated, null, 2)
          }]
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: err.message || String(err) }]
        };
      }
    }
  );

  // 5. Delete host profile
  server.tool(
    'ssh_delete_host',
    'Delete a saved SSH host profile by id or name',
    {
      host: z.string().describe('Host profile id or name to delete')
    },
    async ({ host }) => {
      try {
        const res = SkillTools.deleteHost(host);
        return {
          content: [{ type: 'text' as const, text: `Deleted host profile '${res.name}'` }]
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: err.message || String(err) }]
        };
      }
    }
  );

  // 6. List local keys
  server.tool(
    'ssh_list_keys',
    'List local SSH private keys found in ~/.ssh and the sshx keys directory',
    {},
    async () => {
      const keys = SkillTools.listKeys();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(keys, null, 2) }]
      };
    }
  );

  // 7. Test connection
  server.tool(
    'ssh_test_connection',
    'Test connectivity and measure latency to an SSH host',
    {
      host: z.string().describe('Host profile name/id or address [user@]hostname[:port]')
    },
    async ({ host }) => {
      const res = await SkillTools.testConnection(host);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(res, null, 2)
          }
        ]
      };
    }
  );

  // 4. Exec command
  server.tool(
    'ssh_exec',
    'Execute a shell command on remote SSH server and return stdout, stderr, and exit code',
    {
      host: z.string().describe('Host profile name/id or address [user@]hostname[:port]'),
      command: z.string().describe('Shell command to execute'),
      timeout: z.number().optional().describe('Timeout in seconds (default 30)')
    },
    async ({ host, command, timeout }) => {
      try {
        const result = await SkillTools.exec(host, command, { timeout });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Execution failed: ${err.message || String(err)}`
            }
          ]
        };
      }
    }
  );

  // 5. SFTP list directory
  server.tool(
    'ssh_sftp_list',
    'List files and directories in remote path via SFTP',
    {
      host: z.string().describe('Host profile name/id or address [user@]hostname[:port]'),
      path: z.string().optional().describe('Remote path to list (default ".")')
    },
    async ({ host, path }) => {
      try {
        const files = await SkillTools.sftpList(host, path || '.');
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(files, null, 2)
            }
          ]
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: 'text', text: `SFTP list failed: ${err.message}` }]
        };
      }
    }
  );

  // 6. SFTP upload file
  server.tool(
    'ssh_upload_file',
    'Upload content or local file to remote destination path via SFTP',
    {
      host: z.string().describe('Host profile name/id or address [user@]hostname[:port]'),
      remotePath: z.string().describe('Destination file path on remote server'),
      content: z.string().optional().describe('Raw text content to write to remote file'),
      localPath: z.string().optional().describe('Path to local file to upload')
    },
    async ({ host, remotePath, content, localPath }) => {
      try {
        const res = await SkillTools.uploadFile(host, remotePath, { content, localPath });
        return {
          content: [
            {
              type: 'text',
              text: `Successfully uploaded to ${res.path} (${res.size} bytes)`
            }
          ]
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: 'text', text: `SFTP upload failed: ${err.message}` }]
        };
      }
    }
  );

  // 7. SFTP download file
  server.tool(
    'ssh_download_file',
    'Download remote file to local path or return its text content',
    {
      host: z.string().describe('Host profile name/id or address [user@]hostname[:port]'),
      remotePath: z.string().describe('Source file path on remote server'),
      localPath: z.string().optional().describe('Local destination path (if omitted, content is returned)')
    },
    async ({ host, remotePath, localPath }) => {
      try {
        const res = await SkillTools.downloadFile(host, remotePath, localPath);
        if (localPath) {
          return {
            content: [{ type: 'text', text: `Successfully downloaded to ${res.localPath} (${res.size} bytes)` }]
          };
        } else {
          return {
            content: [
              {
                type: 'text',
                text: res.content || ''
              }
            ]
          };
        }
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: 'text', text: `SFTP download failed: ${err.message}` }]
        };
      }
    }
  );

  // 8. System info
  server.tool(
    'ssh_system_info',
    'Inspect remote server hardware, OS, kernel, memory, disk, and uptime',
    {
      host: z.string().describe('Host profile name/id or address [user@]hostname[:port]')
    },
    async ({ host }) => {
      try {
        const info = await SkillTools.getSystemInfo(host);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(info, null, 2)
            }
          ]
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: 'text', text: `System inspection failed: ${err.message}` }]
        };
      }
    }
  );

  // 9. Generate SSH key
  server.tool(
    'ssh_generate_key',
    'Generate a new Ed25519 or RSA SSH keypair',
    {
      type: z.enum(['ed25519', 'rsa']).optional().describe('Key algorithm (default ed25519)'),
      bits: z.number().optional().describe('RSA bits (2048, 3072, 4096)'),
      comment: z.string().optional().describe('Key comment')
    },
    async ({ type, bits, comment }) => {
      const res = SkillTools.generateKey({ type, bits, comment });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(res, null, 2)
          }
        ]
      };
    }
  );

  return server;
}

export async function startMcpServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
