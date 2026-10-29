# sshx

跨平台 SSH 客户端。TypeScript + Node.js 实现，提供三种用法：

- **CLI**：命令行连接、执行、SFTP、隧道，以及主机增删改查
- **TUI**：交互式主机启动器，操作方式参考 [sshs](https://github.com/quantumsheep/sshs)
- **MCP**：给 AI Agent 用的 Model Context Protocol 服务

支持 Linux、macOS、Windows。不依赖本机 C++ 编译。

## 功能

- 密码、私钥（Ed25519 / RSA，可带口令）、SSH Agent 认证
- 主机配置里保存的密码会在 CLI 和 TUI 连接时自动使用，不再询问
- 主机增删改查，标签、备注、跳板机（ProxyJump）、ProxyCommand
- 导入 OpenSSH `~/.ssh/config`，导入 / 导出 JSON 配置
- 本地转发 `-L`、远程转发 `-R`、SOCKS5 动态转发 `-D`
- SFTP 列目录、上传、下载、删除
- 会话可录制成 Asciinema v2 `.cast`
- 主机密钥校验，写入 `~/.ssh/known_hosts`

## 环境要求

- Node.js 20 或更高（开发与测试使用 Node.js 22+）
- npm、pnpm 或 yarn 任一即可

## 安装

### 从源码安装（推荐）

```bash
git clone https://github.com/OWNER/sshx.git
cd sshx
npm install
npm run build
npm link
```

使用 pnpm 时把上面的 `npm` 换成 `pnpm`。`npm link` 之后，任意目录都可以直接运行 `sshx`。

确认安装：

```bash
sshx --help
sshx --version
```

不想全局链接时，在仓库目录里用：

```bash
node bin/sshx.js --help
```

### 仅作为当前项目的命令

```bash
npm install
npm run build
npx sshx host list
```

### 配置文件位置

三端共用同一份配置：

| 系统 | 目录 |
|------|------|
| Linux / macOS | `~/.config/sshx/`（或 `$XDG_CONFIG_HOME/sshx`） |
| Windows | `%APPDATA%\sshx\` |

- `hosts.json`：主机列表。密码和私钥路径写在这里，文件权限 `0600`
- `config.json`：客户端设置
- `keys/`：`sshx keygen` 生成的密钥

换机器时拷贝整个目录，或：

```bash
sshx host export hosts.json
# 到另一台机器
sshx host import hosts.json
```

也可以用环境变量改位置：

```bash
export SSHX_CONFIG_DIR=~/shared/sshx
export SSHX_HOSTS_FILE=~/shared/sshx/hosts.json
export SSHX_CONFIG_FILE=~/shared/sshx/config.json
```

## 快速开始

```bash
# 保存一台用密码登录的主机
sshx host add --name dev --host 192.168.1.10 --username root \
  --auth password --password 'your-password'

# 保存一台用私钥登录的主机
sshx host add --name prod --host 10.0.0.5 --username ubuntu \
  --auth key -i ~/.ssh/id_ed25519

# 列出、查看、修改、删除
sshx host list
sshx host show dev
sshx host edit dev --port 2222
sshx host remove dev

# 直接连接。已保存密码时不会再提示输入
sshx dev
sshx connect prod

# 不进交互界面，执行一条命令
sshx exec dev "uname -a"
```

没有参数、并且当前是终端时，`sshx` 会打开 TUI。

## CLI

```bash
sshx connect user@192.168.1.100 -p 22
sshx connect internal-db -J bastion
sshx connect prod --record session.cast
sshx connect user@example.com -L 8080:localhost:80 -D 1080

sshx exec user@example.com "uptime" --json
sshx sftp ls user@example.com /var/log
sshx sftp get user@example.com /var/log/syslog ./syslog
sshx sftp put user@example.com ./config.json /etc/myapp/config.json
sshx sftp rm user@example.com /tmp/old.log

sshx tunnel user@remote -L 8080:127.0.0.1:80 -D 1080

sshx ls
sshx host list --json
sshx host test prod
sshx host import-ssh-config
sshx host export hosts.json
sshx host import hosts.json

sshx keygen -t ed25519 -f ~/.ssh/id_ed25519_new -C "me@laptop"
```

`sshx host add` 不带参数时会进入交互向导。常用参数：

| 参数 | 含义 |
|------|------|
| `-n, --name` | 配置名称 |
| `-H, --host` | 地址 |
| `-p, --port` | 端口，默认 22 |
| `-u, --username` | 用户名 |
| `-a, --auth` | `key` 或 `password` |
| `--password` | 要保存的密码 |
| `-i, --identity` / `-k, --key` | 私钥路径 |
| `-J, --jump` | 跳板机配置名 |
| `-t, --tags` | 标签 |
| `--notes` | 备注 |

## TUI

```bash
sshx tui
sshx tui -s "prod web"
sshx tui --color dracula
sshx tui --sort fancy
```

`--color` 可选 `default`、`dracula`、`nord`、`catppuccin`。`--sort` 可选 `name`（默认）、`none`（保持保存顺序）、`fancy`（收藏优先，其次最近连接）。

| 按键 | 作用 |
|------|------|
| 直接输入 | 实时搜索。空格分隔的词都要匹配名称、地址、用户、标签或备注 |
| Backspace | 删掉最后一个搜索字符 |
| ↑ ↓ / k j / Ctrl-K Ctrl-J | 移动 |
| PgUp PgDn / Home End | 翻页、跳到头尾 |
| Enter | 连接。已保存密码自动填入，结束后回到列表 |
| a | 新建主机 |
| e | 编辑选中主机 |
| d | 删除（需要输入 `yes`） |
| t | 测试延迟 |
| i | 导入 `~/.ssh/config` |
| * | 收藏 / 取消收藏 |
| Ctrl-R | 从磁盘重新加载 |
| Esc | 先清空搜索，搜索为空时退出 |
| Ctrl-C | 退出 |

新建和编辑表单里：Tab 或 ↑↓ 切换字段，Ctrl-S 保存，Esc 取消。密码显示为 `*`。

## MCP

在 Claude Code 里登记：

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

还没全局安装时，把 `command` 写成 `node`，`args` 写成 `sshx` 仓库里 `bin/sshx.js` 的绝对路径再加上 `mcp`。

工具：

1. `ssh_list_hosts` 列出主机
2. `ssh_get_host` 查看一台主机（含已存密码和密钥路径）
3. `ssh_add_host` 新建
4. `ssh_update_host` 修改
5. `ssh_delete_host` 删除
6. `ssh_list_keys` 列出本机私钥
7. `ssh_test_connection` 测连通和延迟
8. `ssh_exec` 执行远程命令
9. `ssh_sftp_list` / `ssh_upload_file` / `ssh_download_file` 文件操作
10. `ssh_system_info` 查看系统信息
11. `ssh_generate_key` 生成密钥

命令行也可以直接调：

```bash
sshx skill hosts
sshx skill exec dev "uname -a"
sshx skill inspect dev
sshx skill sftp-ls dev /var/log
```

## 开发

```bash
pnpm install
pnpm run build          # 编译到 dist/
pnpm test               # 编译并跑测试
pnpm run dev:tui        # 不编译，直接开 TUI
pnpm run dev:cli -- --help
pnpm run dev:mcp
```

`scripts/build.sh` 是一条从干净依赖到可执行文件的构建脚本，CI 和本地都能用：

```bash
bash scripts/build.sh
```

它会安装依赖、用 `tsc` 编译、检查 `node bin/sshx.js --version` 能跑。默认用 npm；已经装了 pnpm 时用 pnpm。

推送到 `master` 或 `main`，以及打开 Pull Request 时，GitHub Actions 会在 Ubuntu 上执行同一套构建和测试。

## 测试

```bash
pnpm test
```

测试使用内置的模拟 SSH 服务，覆盖配置读写、密钥生成、连接与命令执行、SFTP、端口转发、CLI 和 MCP。

## 安全说明

`hosts.json` 里的密码是明文，只靠文件权限 `0600` 保护。不要把这个文件提交到 git，也不要放进共享目录以外的不受信任位置。导出文件同样包含密码。

## 许可

MIT
