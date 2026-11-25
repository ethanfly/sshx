import readline from 'node:readline';
import { ScreenBuffer } from './screen.js';
import { HostsScreen, HostSortMode } from './screens/hosts.js';
import { runForm, FormField } from './form.js';
import { resolveTheme, TuiTheme } from './theme.js';
import { runConnect } from '../cli/connect.js';
import { defaultConfigManager, HostProfile, HostProfileUpdate } from '../core/config.js';
import { defaultSyncManager } from '../sync/manager.js';
import { colors } from '../cli/utils.js';
import { errorMessage } from '../core/errors.js';

export interface TuiOptions {
  search?: string;
  color?: string;
  sort?: HostSortMode;
}

export class TuiApp {
  private screen: ScreenBuffer;
  private theme: TuiTheme;
  private running = false;
  private inModal = false;
  public hostsScreen: HostsScreen;

  constructor(options: TuiOptions = {}) {
    this.screen = new ScreenBuffer();
    const appConfig = defaultConfigManager.getAppConfig();
    this.theme = resolveTheme(options.color ?? appConfig.theme);
    this.hostsScreen = new HostsScreen({ search: options.search, sort: options.sort });
  }

  public async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.screen.enterAltScreen();

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      readline.emitKeypressEvents(process.stdin);
    }

    const onResize = () => {
      this.screen.updateDimensions();
      if (!this.inModal) this.render();
    };
    process.stdout.on('resize', onResize);

    const onKeypress = async (str: string | undefined, key: readline.Key) => {
      if (!this.running || this.inModal) return;
      try {
        const quit = await this.handleInput(str, key);
        if (quit) {
          this.stop();
          return;
        }
        if (this.running && !this.inModal) this.render();
      } catch (err) {
        this.hostsScreen.statusMessage = errorMessage(err);
        if (this.running) this.render();
      }
    };
    process.stdin.on('keypress', onKeypress);

    this.render();

    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (!this.running) {
          clearInterval(timer);
          process.stdin.removeListener('keypress', onKeypress);
          process.stdout.removeListener('resize', onResize);
          this.screen.exitAltScreen();
          if (process.stdin.isTTY) {
            process.stdin.setRawMode(false);
            process.stdin.pause();
          }
          resolve();
        }
      }, 40);
    });
  }

  public stop(): void {
    this.running = false;
  }

  private render(): void {
    this.screen.clear();
    this.hostsScreen.render(this.screen, this.theme);
    this.screen.flush();
  }

  private visibleRows(): number {
    return Math.max(1, this.screen.rows - 5);
  }

  private async handleInput(str: string | undefined, key: readline.Key): Promise<boolean> {
    if (key?.ctrl && key.name === 'c') return true;

    if (this.hostsScreen.searchMode) {
      if (key?.name === 'escape') {
        this.hostsScreen.searchMode = false;
        return false;
      }
      if (key?.ctrl && key.name === 'u') {
        this.hostsScreen.clearFilter();
        return false;
      }
      if (key?.name === 'up' || (key?.ctrl && key.name === 'p') || (key?.ctrl && key.name === 'k')) {
        this.hostsScreen.move(-1, this.visibleRows());
        return false;
      }
      if (key?.name === 'down' || (key?.ctrl && key.name === 'n') || (key?.ctrl && key.name === 'j')) {
        this.hostsScreen.move(1, this.visibleRows());
        return false;
      }
      if (key?.name === 'pageup') {
        this.hostsScreen.move(-this.visibleRows(), this.visibleRows());
        return false;
      }
      if (key?.name === 'pagedown') {
        this.hostsScreen.move(this.visibleRows(), this.visibleRows());
        return false;
      }
      if (key?.name === 'home') {
        this.hostsScreen.jump(0, this.visibleRows());
        return false;
      }
      if (key?.name === 'end') {
        this.hostsScreen.jump(this.hostsScreen.getFilteredHosts().length - 1, this.visibleRows());
        return false;
      }
      if (key?.name === 'backspace') {
        this.hostsScreen.backspaceFilter();
        return false;
      }
      if (key?.name === 'return') {
        await this.connectSelected();
        return false;
      }
      if (str && str.length > 0 && !key?.ctrl && !key?.meta) {
        this.hostsScreen.appendFilter(str);
      }
      return false;
    }

    if (key?.name === 'escape') {
      if (this.hostsScreen.filterQuery) {
        this.hostsScreen.clearFilter();
        return false;
      }
      return true;
    }
    if (key?.ctrl && key.name === 'r') {
      this.hostsScreen.refreshHosts();
      this.hostsScreen.statusMessage = 'reloaded';
      return false;
    }
    if (key?.name === 'up' || (key?.ctrl && key.name === 'p') || (key?.ctrl && key.name === 'k') || str === 'k') {
      this.hostsScreen.move(-1, this.visibleRows());
      return false;
    }
    if (key?.name === 'down' || (key?.ctrl && key.name === 'n') || (key?.ctrl && key.name === 'j') || str === 'j') {
      this.hostsScreen.move(1, this.visibleRows());
      return false;
    }
    if (key?.name === 'pageup') {
      this.hostsScreen.move(-this.visibleRows(), this.visibleRows());
      return false;
    }
    if (key?.name === 'pagedown') {
      this.hostsScreen.move(this.visibleRows(), this.visibleRows());
      return false;
    }
    if (key?.name === 'home') {
      this.hostsScreen.jump(0, this.visibleRows());
      return false;
    }
    if (key?.name === 'end') {
      this.hostsScreen.jump(this.hostsScreen.getFilteredHosts().length - 1, this.visibleRows());
      return false;
    }
    if (key?.name === 'backspace') {
      this.hostsScreen.backspaceFilter();
      return false;
    }
    if (str === '/') {
      this.hostsScreen.searchMode = true;
      return false;
    }
    if (str === 'a') {
      await this.addHost();
      return false;
    }
    if (str === 'e') {
      await this.editHost();
      return false;
    }
    if (str === 'd') {
      await this.deleteHost();
      return false;
    }
    if (str === 'i') {
      await this.importConfig();
      return false;
    }
    if (str === 't') {
      this.render();
      await this.hostsScreen.testSelectedLatency();
      return false;
    }
    if (str === '*') {
      this.toggleFavorite();
      return false;
    }
    if (str === 'S' || (key?.ctrl && key.name === 's')) {
      await this.syncCloud();
      return false;
    }
    if (key?.name === 'return') {
      await this.connectSelected();
      return false;
    }
    return false;
  }

  private suspendForConnection(): void {
    this.inModal = true;
    if (process.stdin.isTTY && process.stdin.setRawMode) {
      process.stdin.setRawMode(false);
    }
  }

  private resumeAfterConnection(): void {
    this.inModal = false;
    if (process.stdin.isTTY && process.stdin.setRawMode) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
  }

  private async addHost(): Promise<void> {
    const values = await this.editForm('Add host', blankHost());
    if (!values) return;
    const profile = valuesToProfile(values);
    if (!profile) {
      this.hostsScreen.statusMessage = 'name, host and username are required';
      return;
    }
    const saved = defaultConfigManager.addHost(profile);
    this.hostsScreen.refreshHosts();
    this.hostsScreen.statusMessage = `saved ${saved.name}`;
  }

  private async editHost(): Promise<void> {
    const current = this.hostsScreen.getSelectedHost();
    if (!current) {
      this.hostsScreen.statusMessage = 'no host selected';
      return;
    }
    const values = await this.editForm(`Edit ${current.name}`, hostToFields(current));
    if (!values) return;
    const updates = valuesToUpdate(values);
    if (!updates) {
      this.hostsScreen.statusMessage = 'name, host and username are required';
      return;
    }
    defaultConfigManager.updateHost(current.id, updates);
    this.hostsScreen.refreshHosts();
    this.hostsScreen.statusMessage = `updated ${updates.name}`;
  }

  private async editForm(
    title: string,
    fields: FormField[],
    footerHint = 'tab/↑↓ field   enter next   ctrl-s save   esc cancel'
  ): Promise<Record<string, string> | null> {
    this.inModal = true;
    try {
      const result = await runForm(this.screen, this.theme, title, fields, footerHint);
      if (result.cancelled) {
        this.hostsScreen.statusMessage = 'cancelled';
        return null;
      }
      return result.values;
    } finally {
      this.inModal = false;
    }
  }

  private async deleteHost(): Promise<void> {
    const current = this.hostsScreen.getSelectedHost();
    if (!current) return;
    const values = await this.editForm(
      `Delete ${current.name}?`,
      [{ key: 'confirm', label: 'type yes', value: '', hint: 'yes' }],
      'type yes then ctrl-s to delete   esc cancel'
    );
    if (!values) return;
    if (values.confirm.trim().toLowerCase() !== 'yes') {
      this.hostsScreen.statusMessage = 'cancelled';
      return;
    }
    defaultConfigManager.deleteHost(current.id);
    this.hostsScreen.refreshHosts();
    this.hostsScreen.statusMessage = `deleted ${current.name}`;
  }

  private async importConfig(): Promise<void> {
    const values = await this.editForm(
      'Import OpenSSH config',
      [{ key: 'path', label: 'config path', value: '~/.ssh/config' }],
      'ctrl-s import   esc cancel'
    );
    if (!values) return;
    const imported = defaultConfigManager.importOpenSSHConfig(values.path || undefined);
    this.hostsScreen.refreshHosts();
    this.hostsScreen.statusMessage = `imported ${imported.length} host(s)`;
  }

  private toggleFavorite(): void {
    const current = this.hostsScreen.getSelectedHost();
    if (!current) return;
    defaultConfigManager.updateHost(current.id, { favorite: !current.favorite });
    this.hostsScreen.refreshHosts();
    this.hostsScreen.statusMessage = current.favorite ? `unpinned ${current.name}` : `pinned ${current.name}`;
  }

  private async syncCloud(): Promise<void> {
    const config = defaultSyncManager.getConfig();
    if (!config) {
      this.hostsScreen.statusMessage = 'sync not configured (run: sshx sync setup)';
      return;
    }

    const needsPassphrase = !config.passphrase && !process.env.SSHX_SYNC_PASSPHRASE;
    const fields: FormField[] = [
      { key: 'action', label: 'action', value: 'pull', hint: 'pull (merge) | push | overwrite' },
      ...(needsPassphrase ? [{ key: 'passphrase', label: 'passphrase', value: '', secret: true }] : [])
    ];
    const values = await this.editForm(`Cloud Sync (${config.provider})`, fields, 'ctrl-s run   esc cancel');
    if (!values) return;

    const action = values.action.trim().toLowerCase() || 'pull';
    if (action !== 'pull' && action !== 'push' && action !== 'overwrite') {
      this.hostsScreen.statusMessage = 'invalid sync action: use pull, push, or overwrite';
      return;
    }
    const pass = values.passphrase || undefined;

    this.hostsScreen.statusMessage = `syncing (${action}) with ${config.provider}...`;
    this.render();

    try {
      if (action === 'push') {
        const res = await defaultSyncManager.push(pass);
        this.hostsScreen.statusMessage = `pushed ${res.count} hosts to ${config.provider}`;
      } else {
        const res = await defaultSyncManager.pull(pass, action === 'overwrite' ? 'overwrite' : 'merge');
        this.hostsScreen.refreshHosts();
        this.hostsScreen.statusMessage = `synced ${res.total} hosts (${res.imported} new, ${res.updated} updated)`;
      }
    } catch (err) {
      this.hostsScreen.statusMessage = `sync failed: ${errorMessage(err)}`;
    }
  }

  private async connectSelected(): Promise<void> {
    const host = this.hostsScreen.getSelectedHost();
    if (!host) return;
    try {
      this.suspendForConnection();
      this.screen.exitAltScreen();
      await runConnect(host.id, { noExitOnError: true });
    } catch (err) {
      process.stdout.write(`\n${colors.yellow}Press any key to return to sshx...${colors.reset}`);
      if (process.stdin.isTTY) {
        await new Promise<void>((resolve) => {
          process.stdin.setRawMode(true);
          process.stdin.resume();
          process.stdin.once('data', () => resolve());
        });
      }
      this.hostsScreen.statusMessage = `Connection failed: ${errorMessage(err)}`;
    } finally {
      this.resumeAfterConnection();
      this.screen.updateDimensions();
      this.screen.enterAltScreen();
      this.hostsScreen.refreshHosts();
      this.render();
    }
  }
}

function blankHost(): FormField[] {
  const appConfig = defaultConfigManager.getAppConfig();
  return [
    { key: 'name', label: 'name', value: '' },
    { key: 'host', label: 'host', value: '' },
    { key: 'port', label: 'port', value: String(appConfig.defaultPort || 22) },
    { key: 'username', label: 'username', value: appConfig.defaultUsername || 'root' },
    { key: 'authType', label: 'auth', value: 'key', hint: 'key | password | agent' },
    { key: 'privateKeyPath', label: 'key path', value: appConfig.defaultKeyPath || '~/.ssh/id_ed25519' },
    { key: 'password', label: 'password', value: '', secret: true },
    { key: 'passphrase', label: 'key passphrase', value: '', secret: true },
    { key: 'proxyJump', label: 'jump host', value: '' },
    { key: 'proxyCommand', label: 'proxy cmd', value: '' },
    { key: 'tags', label: 'tags', value: '', hint: 'comma separated' },
    { key: 'notes', label: 'notes', value: '' }
  ];
}

function hostToFields(host: HostProfile): FormField[] {
  const auth = host.authType === 'privateKey' ? 'key' : host.authType === 'password' ? 'password' : host.authType;
  return [
    { key: 'name', label: 'name', value: host.name },
    { key: 'host', label: 'host', value: host.host },
    { key: 'port', label: 'port', value: String(host.port || 22) },
    { key: 'username', label: 'username', value: host.username },
    { key: 'authType', label: 'auth', value: auth, hint: 'key | password | agent' },
    { key: 'privateKeyPath', label: 'key path', value: host.privateKeyPath || '' },
    { key: 'password', label: 'password', value: host.password || '', secret: true },
    { key: 'passphrase', label: 'key passphrase', value: host.passphrase || '', secret: true },
    { key: 'proxyJump', label: 'jump host', value: host.proxyJump || '' },
    { key: 'proxyCommand', label: 'proxy cmd', value: host.proxyCommand || '' },
    { key: 'tags', label: 'tags', value: (host.tags || []).join(','), hint: 'comma separated' },
    { key: 'notes', label: 'notes', value: host.notes || '' }
  ];
}

function parseFormAuth(values: Record<string, string>): HostProfile['authType'] {
  const authRaw = values.authType.trim().toLowerCase();
  return authRaw === 'password' || authRaw === '2'
    ? 'password'
    : authRaw === 'agent'
      ? 'agent'
      : 'privateKey';
}

function valuesToProfile(values: Record<string, string>): Omit<HostProfile, 'id'> | null {
  const name = values.name.trim();
  const host = values.host.trim();
  const username = values.username.trim();
  if (!name || !host || !username) return null;

  const authType = parseFormAuth(values);
  const tags = values.tags.split(',').map(t => t.trim()).filter(Boolean);
  const port = parseInt(values.port, 10) || 22;

  return {
    name,
    host,
    port,
    username,
    authType,
    password: values.password || undefined,
    privateKeyPath: authType === 'privateKey' ? (values.privateKeyPath.trim() || undefined) : undefined,
    passphrase: values.passphrase || undefined,
    proxyJump: values.proxyJump.trim() || undefined,
    proxyCommand: values.proxyCommand?.trim() || undefined,
    tags,
    notes: values.notes.trim() || undefined
  };
}

function valuesToUpdate(values: Record<string, string>): HostProfileUpdate | null {
  const name = values.name.trim();
  const host = values.host.trim();
  const username = values.username.trim();
  if (!name || !host || !username) return null;

  const authType = parseFormAuth(values);
  const tags = values.tags.split(',').map(t => t.trim()).filter(Boolean);
  const port = parseInt(values.port, 10) || 22;

  return {
    name,
    host,
    port,
    username,
    authType,
    password: values.password || null,
    privateKeyPath: authType === 'privateKey' ? (values.privateKeyPath.trim() || null) : null,
    passphrase: values.passphrase || null,
    proxyJump: values.proxyJump.trim() || null,
    proxyCommand: values.proxyCommand?.trim() || null,
    tags,
    notes: values.notes.trim() || null
  };
}
