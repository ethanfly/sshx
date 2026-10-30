import { defaultConfigManager, HostProfile } from '../../core/config.js';
import { SSHConnection } from '../../core/client.js';
import { ScreenBuffer, padClip, stringWidth } from '../screen.js';
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

    const layout = computeTableLayout(screen.cols, this.hosts.length > 0 ? this.hosts : list);
    const sep = ' '.repeat(layout.gap);

    const headerParts: string[] = [
      padClip('NAME', layout.name),
      padClip('DESTINATION', layout.dest),
      padClip('AUTH', layout.auth)
    ];
    if (layout.tags > 0) {
      headerParts.push(padClip('TAGS', layout.tags));
    }
    if (layout.notes !== undefined) {
      headerParts.push(padClip('NOTES', layout.notes));
    }
    headerParts.push(padClip('LAST', layout.last));

    const header = `${theme.muted}${headerParts.join(sep)}${colors.reset}`;
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

        const lineParts: string[] = [
          padClip(host.name, layout.name),
          padClip(dest, layout.dest),
          padClip(auth, layout.auth)
        ];
        if (layout.tags > 0) {
          lineParts.push(padClip(tags, layout.tags));
        }
        if (layout.notes !== undefined) {
          const noteText = host.notes || (host.proxyJump ? `via ${host.proxyJump}` : '');
          lineParts.push(padClip(noteText, layout.notes));
        }
        lineParts.push(padClip(last, layout.last));

        const line = lineParts.join(sep);
        const row = listTop + i;
        if (selected) {
          const selectedWidth = Math.max(10, screen.cols - 1);
          screen.writeAt(1, row, `${theme.accentBg}${theme.selectedFg}${padClip(' ' + line, selectedWidth)}${colors.reset}`);
        } else {
          screen.writeAt(2, row, line);
        }
      });
    }

    const statusText = this.statusMessage
      ? this.statusMessage
      : '↑↓/jk move  enter connect  a add  e edit  d delete  t ping  i import  ctrl-r reload  esc quit';
    const statusColor = this.statusMessage ? theme.warn : theme.muted;
    const footerWidth = Math.max(10, screen.cols - 2);
    screen.writeAt(2, footerRow, `${statusColor}${padClip(statusText, footerWidth)}${colors.reset}`);
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

export interface TableLayout {
  name: number;
  dest: number;
  auth: number;
  tags: number;
  notes?: number;
  last: number;
  gap: number;
  totalWidth: number;
}

export function computeTableLayout(screenCols: number, hosts: HostProfile[]): TableLayout {
  const usable = Math.max(30, screenCols - 4);

  let maxName = 4; // 'NAME'
  let maxDest = 11; // 'DESTINATION'
  let maxAuth = 4; // 'AUTH'
  let maxTags = 4; // 'TAGS'
  let maxNotes = 5; // 'NOTES'
  let hasNotes = false;

  for (const h of hosts) {
    const nw = stringWidth(h.name);
    if (nw > maxName) maxName = nw;

    const dw = stringWidth(`${h.username}@${h.host}:${h.port}`);
    if (dw > maxDest) maxDest = dw;

    const aw = stringWidth(authLabel(h));
    if (aw > maxAuth) maxAuth = aw;

    const tw = stringWidth((h.favorite ? '★ ' : '') + (h.tags || []).join(','));
    if (tw > maxTags) maxTags = tw;

    const noteText = h.notes || (h.proxyJump ? `via ${h.proxyJump}` : '');
    if (noteText && noteText.trim()) {
      hasNotes = true;
      const noteW = stringWidth(noteText.trim());
      if (noteW > maxNotes) maxNotes = noteW;
    }
  }

  // Base sizing based on content with breathing room
  let name = Math.max(14, Math.min(26, maxName + 1));
  let dest = Math.max(20, Math.min(32, maxDest + 1));
  let auth = Math.max(12, Math.min(22, maxAuth + 1));
  let tags = Math.max(10, Math.min(28, maxTags + 1));
  let last = 12;
  let gap = usable >= 70 ? 2 : 1;

  // Check if wide screen can fit NOTES column
  const baseWithoutNotes = name + dest + auth + tags + last + 4 * gap;
  let notes: number | undefined = undefined;

  if (hasNotes && usable >= 110 && usable >= baseWithoutNotes + 14 + gap) {
    const availableForNotes = usable - baseWithoutNotes - gap;
    notes = Math.max(12, Math.min(Math.min(34, maxNotes + 1), availableForNotes));
  }

  let totalWidth = name + dest + auth + tags + (notes !== undefined ? notes + gap : 0) + last + 4 * gap;

  // On tight screens, gracefully compress or drop columns
  if (totalWidth > usable) {
    gap = 1;
    totalWidth = name + dest + auth + tags + (notes !== undefined ? notes + gap : 0) + last + 4 * gap;
    if (totalWidth > usable && notes !== undefined) {
      notes = undefined;
      totalWidth = name + dest + auth + tags + last + 4 * gap;
    }
    if (totalWidth > usable && usable < 65) {
      tags = 0;
      totalWidth = name + dest + auth + last + 3 * gap;
    }
    if (totalWidth > usable) {
      const excess = totalWidth - usable;
      dest = Math.max(14, dest - Math.ceil(excess * 0.6));
      name = Math.max(10, name - Math.floor(excess * 0.4));
      totalWidth = name + dest + auth + (tags > 0 ? tags + gap : 0) + last + (tags > 0 ? 4 : 3) * gap;
    }
  }

  return { name, dest, auth, tags, notes, last, gap, totalWidth };
}
