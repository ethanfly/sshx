#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const realScript = fs.realpathSync(__filename);
const packageRoot = path.dirname(path.dirname(realScript));
const distCli = path.join(packageRoot, 'dist', 'cli', 'index.js');

let createCli;
if (fs.existsSync(distCli)) {
  const mod = await import(distCli);
  createCli = mod.createCli;
} else {
  // If dist not built yet, fallback to tsx runner
  const mod = await import('../src/cli/index.ts');
  createCli = mod.createCli;
}

const program = createCli();
await program.parseAsync(process.argv);
