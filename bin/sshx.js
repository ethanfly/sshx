#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distCli = path.join(__dirname, '..', 'dist', 'cli', 'index.js');

if (fs.existsSync(distCli)) {
  await import(distCli);
} else {
  // If dist not built yet, fallback to tsx runner
  const { createCli } = await import('../src/cli/index.ts');
  const program = createCli();
  await program.parseAsync(process.argv);
}
