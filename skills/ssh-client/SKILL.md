---
name: ssh-client
description: Full-featured SSH client skill for AI agents to connect to remote servers, execute commands, transfer files via SFTP, inspect system metrics, and manage port forwarding tunnels.
---

# SSH Client Skill (sshx)

This skill enables AI agents to interact with remote Linux, macOS, and Windows machines using the standard SSH protocol, SFTP, and port forwarding.

## Capabilities

1. **Remote Command Execution (`ssh_exec`)**: Execute commands non-interactively, receiving exit codes, stdout, and stderr.
2. **SFTP File Management (`ssh_sftp_list`, `ssh_upload_file`, `ssh_download_file`)**: Upload scripts, configurations, download logs, inspect directory trees.
3. **Remote System Inspection (`ssh_system_info`)**: Query remote OS, kernel, CPU, RAM, disk usage, uptime, and load.
4. **Host Management (`ssh_list_hosts`, `ssh_add_host`, `ssh_test_connection`)**: Manage saved host profiles, authentication keys, and bastion jump hosts.
5. **Key Management (`ssh_generate_key`)**: Generate modern Ed25519 or RSA SSH keypairs.
6. **Port Forwarding**: Local (`-L`), Remote (`-R`), and Dynamic SOCKS5 (`-D`) tunneling.

---

## MCP Server Setup

To enable this skill in Claude Desktop or Claude Code, add the MCP server configuration:

### For Claude Desktop (`claude_desktop_config.json`)
```json
{
  "mcpServers": {
    "sshx": {
      "command": "node",
      "args": ["/path/to/sshx/bin/sshx.js", "mcp"]
    }
  }
}
```

### For Claude Code (`.claude/settings.json`)
```json
{
  "mcpServers": {
    "sshx": {
      "command": "sshx",
      "args": ["mcp"]
    }
  }
}
```

---

## CLI Skill Invocation

AI agents can also directly invoke the skill via CLI:

```bash
# List saved hosts
sshx skill hosts

# Execute command on remote host
sshx skill exec <host> "uname -a && uptime"

# Inspect remote server specs
sshx skill inspect <host>

# List remote directory
sshx skill sftp-ls <host> /var/log

# Upload text file
sshx skill upload <host> /tmp/config.json '{"env":"prod"}'

# Download remote file
sshx skill download <host> /var/log/nginx/error.log
```

---

## Tool Reference

### `ssh_exec`
- `host` (string, required): Saved host name or `[user@]hostname[:port]`
- `command` (string, required): Shell command to execute
- `timeout` (number, optional): Timeout in seconds (default: 30)

### `ssh_system_info`
- `host` (string, required): Target host

### `ssh_sftp_list`
- `host` (string, required): Target host
- `path` (string, optional): Remote path to list (default: `.`)

### `ssh_upload_file`
- `host` (string, required): Target host
- `remotePath` (string, required): Remote destination path
- `content` (string, optional): Text content to write directly
- `localPath` (string, optional): Local file path to upload

### `ssh_download_file`
- `host` (string, required): Target host
- `remotePath` (string, required): Remote file to download
- `localPath` (string, optional): Local path to save to (if omitted, content is returned directly)
