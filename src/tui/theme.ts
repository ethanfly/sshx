import { colors } from '../cli/utils.js';

export type ThemeName = 'default' | 'dracula' | 'nord' | 'catppuccin';

export interface TuiTheme {
  name: ThemeName;
  accent: string;
  accentBg: string;
  title: string;
  selectedFg: string;
  border: string;
  muted: string;
  warn: string;
  ok: string;
  danger: string;
}

const themes: Record<ThemeName, TuiTheme> = {
  default: {
    name: 'default',
    accent: colors.brightCyan,
    accentBg: colors.bgCyan,
    title: colors.bold + colors.brightCyan,
    selectedFg: colors.black,
    border: colors.cyan,
    muted: colors.gray,
    warn: colors.yellow,
    ok: colors.green,
    danger: colors.red
  },
  dracula: {
    name: 'dracula',
    accent: colors.brightMagenta,
    accentBg: colors.bgMagenta,
    title: colors.bold + colors.brightMagenta,
    selectedFg: colors.black,
    border: colors.magenta,
    muted: colors.gray,
    warn: colors.yellow,
    ok: colors.green,
    danger: colors.red
  },
  nord: {
    name: 'nord',
    accent: colors.brightBlue,
    accentBg: colors.bgBlue,
    title: colors.bold + colors.brightBlue,
    selectedFg: colors.brightWhite,
    border: colors.blue,
    muted: colors.gray,
    warn: colors.yellow,
    ok: colors.green,
    danger: colors.red
  },
  catppuccin: {
    name: 'catppuccin',
    accent: colors.brightMagenta,
    accentBg: colors.bgBlue,
    title: colors.bold + colors.brightBlue,
    selectedFg: colors.brightWhite,
    border: colors.blue,
    muted: colors.gray,
    warn: colors.yellow,
    ok: colors.green,
    danger: colors.red
  }
};

export function resolveTheme(name?: string): TuiTheme {
  if (name && name in themes) return themes[name as ThemeName];
  return themes.default;
}
