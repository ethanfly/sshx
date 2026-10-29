import { defaultConfigManager, HostProfile } from '../../core/config.js';
import { SSHConnection } from '../../core/client.js';
import { ScreenBuffer, padClip } from '../screen.js';
import { TuiTheme } from '../theme.js';
import { colors } from '../../cli/utils.js';

export type HostSortMode = 'name' | 'none' | 'fancy';

export class HostsScreen {
  public selectedIndex: number = 0;
  public scrollOffset: number = 0;
  public filterQuery: string = '';
  public statusMessage: string = '';
  public sortMode: HostSortMode = 'name';
  private hosts: HostProfile[] = [];
  private latencyMap: Map<string, number> = new Map();

  constructor(options: { search?: string; sort?: HostSortMode } = {}) {
    this.filterQuery = options.search || '';
    this.sortMode = options.sort || 'name';
    this.refreshHosts();
  }

  public refreshHosts(): void {
    const selected = this.getSelectedHost();
    this.hosts = defaultConfigManager.getHosts();
    const list = this.getFilteredHosts();
    if (selected) {
      const idx = list.findIndex(h => h.id === selected.id);
      this.selectedIndex = idx >= 0 ? idx : 0;
    }
    if (this.selectedIndex >= list.length) {
      this.selectedIndex = Math.max(0, list.length - 1);
    }
    this.ensureVisible(Math.max(1, 10));
  }

  public getFilteredHosts(): HostProfile[] {
    const terms = this.filterQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let list = this.hosts.filter(h => {
      if (terms.length === 0) return true;
      const haystack = [
        h.name,
        h.host,
        h.username,
        String(h.port),
        h.notes || '',
        ...(h.tags || [])
      ].join(' ').toLowerCase();
      return terms.every(term => haystack.includes(term));
    });

    if (this.sortMode === 'name') {
      list = [...list].sort((a, b) => a.name.localeCompare(b.name));
    } else if (this.sortMode === 'fancy') {
      list = [...list].sort((a, b) => {
        const fav = Number(!!b.favorite) - Number(!!a.favorite);
        if (fav !== 0) return fav;
        const at = a.lastConnected ? Date.parse(a.lastConnected) : 0;
        const bt = b.lastConnected ? Date.parse(b.lastConnected) : 0;
        if (bt !== at) return bt - at;
        return a.name.localeCompare(b.name);
      });
    }
    return list;
  }

  public getSelectedHost(): HostProfile | undefined {
    return this.getFilteredHosts()[this.selectedIndex];
  }

  public move(delta: number, visibleRows: number): void {
    const max = Math.max(0, this.getFilteredHosts().length - 1);
    this.selectedIndex = Math.min(max, Math.max(0, this.selectedIndex + delta));
    this.ensureVisible(visibleRows);
  }

  public jump(index: number, visibleRows: number): void {
    const max = Math.max(0, this.getFilteredHosts().length - 1);
    this.selectedIndex = Math.min(max, Math.max(0, index));
    this.ensureVisible(visibleRows);
  }

  private ensureVisible(visibleRows: number): void {
    if (this.selectedIndex < this.scrollOffset) {
      this.scrollOffset = this.selectedIndex;
    } else if (this.selectedIndex >= this.scrollOffset + visibleRows) {
      this.scrollOffset = this.selectedIndex - visibleRows + 1;
    }
  }

  public appendFilter(ch: string): void {
    this.filterQuery += ch;
    this.selectedIndex = 0;
    this.scrollOffset = 0;
  }

  public backspaceFilter(): void {
    this.filterQuery = this.filterQuery.slice(0, -1);
    this.selectedIndex = 0;
    this.scrollOffset = 0;
  }

  public clearFilter(): void {
    this.filterQuery = '';
    this.selectedIndex = 0;
    this.scrollOffset = 0;
  }

  public render(screen: ScreenBuffer, theme: TuiTheme): void {
    const list = this.getFilteredHosts();
    const headerRow = 3;
    const listTop = 4;
    const footerRow = screen.rows;
    const visibleRows = Math.max(1, footerRow - listTop - 1);
    this.ensureVisible(visibleRows);

    const query = this.filterQuery;
    const searchLabel = query.length > 0
      ? `${theme.accent}search:${colors.reset} ${query}${theme.accent}▍${colors.reset}`
      : `${theme.muted}type to search · space = AND${colors.reset}`;
    screen.writeAt(2, 1, `${theme.title}sshx${colors.reset} ${theme.muted}hosts${colors.reset}  ${searchLabel}`);

    const count = `${list.length}/${this.hosts.length}`;
    const right = `${theme.muted}${this.sortMode}  ${count}${colors.reset}`;
    screen.writeAt(Math.max(1, screen.cols - count.length - this.sortMode.length - 4), 1, right);

    const cols = columnWidths(screen.cols);
    const header =
      `${theme.muted}` +
      padClip('NAME', cols.name) + ' ' +
      padClip('DESTINATION', cols.dest) + ' ' +
      padClip('AUTH', cols.auth) + ' ' +
      padClip('TAGS', cols.tags) + ' ' +
      padClip('LAST', cols.last) +
      colors.reset;
    screen.writeAt(2, headerRow, header);

    if (list.length === 0) {
      const empty = this.hosts.length === 0
        ? "No hosts yet. Press 'a' to add one, 'i' to import ~/.ssh/config."
        : `No hosts match "${query}".`;
      screen.writeAt(2, listTop + 1, `${theme.muted}${empty}${colors.reset}`);
    } else {
      const slice = list.slice(this.scrollOffset, this.scrollOffset + visibleRows);
      slice.forEach((host, i) => {
        const absolute = this.scrollOffset + i;
        const selected = absolute === this.selectedIndex;
        const latency = this.latencyMap.get(host.id);
        const dest = `${host.username}@${host.host}:${host.port}`;
        const auth = authLabel(host);
        const tags = (host.favorite ? '★ ' : '') + (host.tags || []).join(',');
        const last = latency !== undefined
          ? `${latency}ms`
          : host.lastConnected
            ? new Date(host.lastConnected).toLocaleDateString()
            : '-';
        const line =
          padClip(host.name, cols.name) + ' ' +
          padClip(dest, cols.dest) + ' ' +
          padClip(auth, cols.auth) + ' ' +
          padClip(tags, cols.tags) + ' ' +
          padClip(last, cols.last);
        const row = listTop + i;
        if (selected) {
          screen.writeAt(1, row, `${theme.accentBg}${theme.selectedFg}${padClip(' ' + line, screen.cols)}${colors.reset}`);
        } else {
          screen.writeAt(2, row, line);
        }
      });
    }

    const status = this.statusMessage
      ? `${theme.warn}${this.statusMessage}${colors.reset}`
      : `${theme.muted}↑↓/jk move  enter connect  a add  e edit  d delete  t ping  i import  ctrl-r reload  esc quit${colors.reset}`;
    screen.writeAt(1, footerRow, padClip(status, screen.cols));
  }

  public async testSelectedLatency(): Promise<void> {
    const selected = this.getSelectedHost();
    if (!selected) return;
    this.statusMessage = `ping ${selected.name}...`;
    const res = await SSHConnection.testLatency(selected);
    if (res.success) {
      this.latencyMap.set(selected.id, res.latencyMs);
      this.statusMessage = `${selected.name} ${res.latencyMs}ms`;
    } else {
      this.statusMessage = `${selected.name} failed: ${res.error}`;
    }
  }
}

function authLabel(host: HostProfile): string {
  if (host.authType === 'password') return host.password ? 'password*' : 'password';
  if (host.authType === 'agent') return 'agent';
  if (host.privateKeyPath) {
    const base = host.privateKeyPath.split('/').pop() || 'key';
    return `key:${base}`;
  }
  return host.authType || 'key';
}

function columnWidths(cols: number): { name: number; dest: number; auth: number; tags: number; last: number } {
  const usable = Math.max(40, cols - 6);
  const last = 12;
  const auth = Math.min(18, Math.floor(usable * 0.16));
  const tags = Math.min(18, Math.floor(usable * 0.16));
  const name = Math.min(22, Math.floor(usable * 0.22));
  const dest = Math.max(16, usable - last - auth - tags - name);
  return { name, dest, auth, tags, last };
}
