import readline from 'node:readline';
import { ScreenBuffer } from './screen.js';
import { HostsScreen, HostSortMode } from './screens/hosts.js';
import { runForm, FormField } from './form.js';
import { resolveTheme, TuiTheme } from './theme.js';
import { runConnect } from '../cli/connect.js';
import { defaultConfigManager, HostProfile } from '../core/config.js';
import { colors } from '../cli/utils.js';

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
    this.theme = resolveTheme(options.color);
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
      } catch (err: any) {
        this.hostsScreen.statusMessage = err?.message || String(err);
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
    if (key?.name === 'return') {
      await this.connectSelected();
      return false;
    }
    if (str && str.length === 1 && !key?.ctrl && !key?.meta && str >= ' ' && str !== '\x1b') {
      this.hostsScreen.appendFilter(str);
    }
    return false;
  }

  private suspend(): void {
    this.inModal = true;
    if (process.stdin.isTTY && process.stdin.setRawMode) {
      process.stdin.setRawMode(false);
    }
  }

  private resume(): void {
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
    const profile = valuesToProfile(values);
    if (!profile) {
      this.hostsScreen.statusMessage = 'name, host and username are required';
      return;
    }
    defaultConfigManager.updateHost(current.id, profile);
    this.hostsScreen.refreshHosts();
    this.hostsScreen.statusMessage = `updated ${profile.name}`;
  }

  private async editForm(title: string, fields: FormField[]): Promise<Record<string, string> | null> {
    this.suspend();
    const result = await runForm(
      this.screen,
      this.theme,
      title,
      fields,
      'tab/↑↓ field   enter next   ctrl-s save   esc cancel'
    );
    this.resume();
    if (result.cancelled) {
      this.hostsScreen.statusMessage = 'cancelled';
      return null;
    }
    return result.values;
  }

  private async deleteHost(): Promise<void> {
    const current = this.hostsScreen.getSelectedHost();
    if (!current) return;
    this.suspend();
    const result = await runForm(
      this.screen,
      this.theme,
      `Delete ${current.name}?`,
      [{ key: 'confirm', label: 'type yes', value: '', hint: 'yes' }],
      'type yes then ctrl-s to delete   esc cancel'
    );
    this.resume();
    if (result.cancelled || result.values.confirm.trim().toLowerCase() !== 'yes') {
      this.hostsScreen.statusMessage = 'cancelled';
      return;
    }
    defaultConfigManager.deleteHost(current.id);
    this.hostsScreen.refreshHosts();
    this.hostsScreen.statusMessage = `deleted ${current.name}`;
  }

  private async importConfig(): Promise<void> {
    this.suspend();
    const result = await runForm(
      this.screen,
      this.theme,
      'Import OpenSSH config',
      [{ key: 'path', label: 'config path', value: '~/.ssh/config' }],
      'ctrl-s import   esc cancel'
    );
    this.resume();
    if (result.cancelled) {
      this.hostsScreen.statusMessage = 'cancelled';
      return;
    }
    const imported = defaultConfigManager.importOpenSSHConfig(result.values.path || undefined);
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

  private async connectSelected(): Promise<void> {
    const host = this.hostsScreen.getSelectedHost();
    if (!host) return;
    this.suspend();
    this.screen.exitAltScreen();
    try {
      await runConnect(host.id, { noExitOnError: true });
    } catch (err: any) {
      process.stdout.write(`\n${colors.yellow}Press any key to return to sshx...${colors.reset}`);
      if (process.stdin.isTTY) {
        await new Promise<void>((resolve) => {
          process.stdin.setRawMode(true);
          process.stdin.resume();
          process.stdin.once('data', () => resolve());
        });
      }
      this.hostsScreen.statusMessage = `Connection failed: ${err?.message || err}`;
    } finally {
      this.screen.updateDimensions();
      this.screen.enterAltScreen();
      this.resume();
      this.hostsScreen.refreshHosts();
      this.render();
    }
  }
}

function blankHost(): FormField[] {
  return [
    { key: 'name', label: 'name', value: '' },
    { key: 'host', label: 'host', value: '' },
    { key: 'port', label: 'port', value: '22' },
    { key: 'username', label: 'username', value: 'root' },
    { key: 'authType', label: 'auth', value: 'key', hint: 'key | password | agent' },
    { key: 'privateKeyPath', label: 'key path', value: '~/.ssh/id_ed25519' },
    { key: 'password', label: 'password', value: '', secret: true },
    { key: 'passphrase', label: 'key passphrase', value: '', secret: true },
    { key: 'proxyJump', label: 'jump host', value: '' },
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
    { key: 'authType', label: 'auth', value: auth },
    { key: 'privateKeyPath', label: 'key path', value: host.privateKeyPath || '' },
    { key: 'password', label: 'password', value: host.password || '', secret: true },
    { key: 'passphrase', label: 'key passphrase', value: host.passphrase || '', secret: true },
    { key: 'proxyJump', label: 'jump host', value: host.proxyJump || '' },
    { key: 'tags', label: 'tags', value: (host.tags || []).join(',') },
    { key: 'notes', label: 'notes', value: host.notes || '' }
  ];
}

function valuesToProfile(values: Record<string, string>): Omit<HostProfile, 'id'> | null {
  const name = values.name.trim();
  const host = values.host.trim();
  const username = values.username.trim();
  if (!name || !host || !username) return null;

  const authRaw = values.authType.trim().toLowerCase();
  const authType: HostProfile['authType'] =
    authRaw === 'password' || authRaw === '2' ? 'password' :
    authRaw === 'agent' ? 'agent' : 'privateKey';

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
    tags,
    notes: values.notes.trim() || undefined
  };
}
