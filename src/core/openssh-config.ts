import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolvePortablePath, toPortablePath } from './config-paths.js';
import type { HostProfile } from './config.js';

/**
 * Parses OpenSSH config file resolving Include directives
 */
export function parseOpenSSHConfigFile(filePath: string, visited: Set<string> = new Set()): Array<Omit<HostProfile, 'id'>> {
  const resolvedPath = resolvePortablePath(filePath);
  if (visited.has(resolvedPath) || !fs.existsSync(resolvedPath)) {
    return [];
  }
  visited.add(resolvedPath);

  const baseDir = path.dirname(resolvedPath);
  const content = fs.readFileSync(resolvedPath, 'utf8');
  return parseOpenSSHConfigContents(content, pattern => {
    const expanded = expandIncludePattern(pattern, baseDir);
    const hosts: Array<Omit<HostProfile, 'id'>> = [];
    for (const candidate of expanded) {
      try {
        if (fs.statSync(candidate).isFile()) {
          hosts.push(...parseOpenSSHConfigFile(candidate, visited));
        }
      } catch {
        // Skip broken symlinks or unreadable files
      }
    }
    return hosts;
  });
}

/**
 * Parses OpenSSH ~/.ssh/config format string
 */
export function parseOpenSSHConfig(content: string): Array<Omit<HostProfile, 'id'>> {
  return parseOpenSSHConfigContents(content);
}

interface HostBlockDraft {
  name: string;
  fields: Partial<HostProfile>;
  explicit: Set<string>;
}

type ParsedItem =
  | { kind: 'host'; draft: HostBlockDraft }
  | { kind: 'included'; hosts: Array<Omit<HostProfile, 'id'>> };

function parseOpenSSHConfigContents(
  content: string,
  include?: (pattern: string) => Array<Omit<HostProfile, 'id'>>
): Array<Omit<HostProfile, 'id'>> {
  const lines = content.split(/\r?\n/);
  const items: ParsedItem[] = [];
  const globalDefaults: Partial<HostProfile> = {};
  const globalExplicit = new Set<string>();
  let mode: 'none' | 'global' | 'hosts' | 'match' = 'none';
  let currentEntries: HostBlockDraft[] = [];

  for (const rawLine of lines) {
    const cleaned = stripInlineComment(rawLine).trim();
    if (!cleaned) continue;

    const directive = parseDirective(cleaned);
    if (!directive) continue;
    const { keyword, rawValue } = directive;

    if (keyword === 'include') {
      if (include) {
        for (const pattern of splitConfigArgs(rawValue)) {
          const included = include(pattern);
          if (included.length > 0) items.push({ kind: 'included', hosts: included });
        }
      }
      continue;
    }

    if (keyword === 'match') {
      mode = 'match';
      currentEntries = [];
      continue;
    }

    if (keyword === 'host') {
      const patterns = splitConfigArgs(rawValue);
      const concreteAliases = patterns.filter(
        pattern => pattern && !pattern.startsWith('!') && !pattern.includes('*') && !pattern.includes('?')
      );
      const hasGlobalWildcard = patterns.includes('*');

      if (concreteAliases.length > 0) {
        mode = 'hosts';
        currentEntries = concreteAliases.map(alias => {
          const draft: HostBlockDraft = {
            name: alias,
            fields: { host: alias },
            explicit: new Set()
          };
          items.push({ kind: 'host', draft });
          return draft;
        });
      } else if (hasGlobalWildcard) {
        mode = 'global';
        currentEntries = [];
      } else {
        mode = 'none';
        currentEntries = [];
      }
      continue;
    }

    if (mode !== 'hosts' && mode !== 'global') continue;

    const applyDirective = (fields: Partial<HostProfile>, explicit: Set<string>) => {
      const setOnce = <K extends keyof HostProfile>(key: K, val: HostProfile[K]) => {
        if (explicit.has(key)) return;
        explicit.add(key);
        fields[key] = val;
      };
      const val = unquote(rawValue);

      switch (keyword) {
        case 'hostname':
          setOnce('host', val);
          break;
        case 'user':
          setOnce('username', val);
          break;
        case 'port': {
          const parsed = parseInt(val, 10);
          if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) {
            setOnce('port', parsed);
          }
          break;
        }
        case 'identityfile':
          setOnce('privateKeyPath', toPortablePath(val));
          setOnce('authType', 'privateKey');
          break;
        case 'preferredauthentications':
          if (val.toLowerCase().startsWith('password')) setOnce('authType', 'password');
          break;
        case 'proxyjump':
          setOnce('proxyJump', val);
          break;
        case 'proxycommand':
          setOnce('proxyCommand', val);
          break;
        case 'serveraliveinterval': {
          const seconds = parseInt(val, 10);
          if (Number.isFinite(seconds) && seconds >= 0) {
            setOnce('keepaliveInterval', seconds * 1000);
          }
          break;
        }
        case 'serveralivecountmax': {
          const count = parseInt(val, 10);
          if (Number.isFinite(count) && count >= 0) {
            setOnce('keepaliveCountMax', count);
          }
          break;
        }
      }
    };

    if (mode === 'global') {
      applyDirective(globalDefaults, globalExplicit);
    } else {
      for (const entry of currentEntries) {
        applyDirective(entry.fields, entry.explicit);
      }
    }
  }

  const hosts: Array<Omit<HostProfile, 'id'>> = [];
  for (const item of items) {
    if (item.kind === 'included') {
      hosts.push(...item.hosts);
    } else {
      finalizeHost(item.draft, globalDefaults, hosts);
    }
  }
  return hosts;
}

function finalizeHost(
  draft: HostBlockDraft,
  globalDefaults: Partial<HostProfile>,
  list: Array<Omit<HostProfile, 'id'>>
): void {
  const f = draft.fields;
  list.push({
    name: draft.name,
    host: f.host || draft.name,
    port: f.port ?? globalDefaults.port ?? 22,
    username: f.username ?? globalDefaults.username ?? os.userInfo().username ?? 'root',
    authType: f.authType ?? globalDefaults.authType ?? 'privateKey',
    privateKeyPath: f.privateKeyPath ?? globalDefaults.privateKeyPath,
    proxyJump: f.proxyJump ?? globalDefaults.proxyJump,
    proxyCommand: f.proxyCommand ?? globalDefaults.proxyCommand,
    keepaliveInterval: f.keepaliveInterval ?? globalDefaults.keepaliveInterval,
    keepaliveCountMax: f.keepaliveCountMax ?? globalDefaults.keepaliveCountMax,
    tags: ['imported-ssh-config']
  });
}

function stripInlineComment(line: string): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#') {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseDirective(line: string): { keyword: string; rawValue: string } | null {
  const match = /^([A-Za-z][A-Za-z0-9]*)\s*(?:=\s*|\s+)(.*)$/.exec(line);
  if (!match) return null;
  return { keyword: match[1].toLowerCase(), rawValue: match[2].trim() };
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function splitConfigArgs(raw: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current) {
        args.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current) args.push(current);
  return args;
}

function wildcardToRegex(pattern: string): RegExp {
  return new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
}

function expandIncludePattern(pattern: string, baseDir: string): string[] {
  const normalizedInput = pattern.startsWith('~') || path.isAbsolute(pattern)
    ? resolvePortablePath(pattern)
    : path.resolve(baseDir, pattern);

  const parsed = path.parse(normalizedInput);
  const relativePart = normalizedInput.slice(parsed.root.length);
  const segments = relativePart.split(path.sep).filter(Boolean);
  let candidates = [parsed.root || path.sep];

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const isLast = i === segments.length - 1;
    const nextCandidates: string[] = [];

    if (!/[*?]/.test(segment)) {
      for (const dir of candidates) {
        nextCandidates.push(path.join(dir, segment));
      }
    } else {
      const regex = wildcardToRegex(segment);
      for (const dir of candidates) {
        let entries: string[];
        try {
          entries = fs.readdirSync(dir).sort();
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (!regex.test(entry)) continue;
          const full = path.join(dir, entry);
          if (!isLast) {
            try {
              if (!fs.statSync(full).isDirectory()) continue;
            } catch {
              continue;
            }
          }
          nextCandidates.push(full);
        }
      }
    }
    candidates = nextCandidates;
    if (candidates.length === 0) break;
  }

  return candidates;
}
