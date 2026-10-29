#!/usr/bin/env bash
# Build sshx from a clean checkout.
# Usage: bash scripts/build.sh
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
  echo "error: node is required (Node.js 20+)" >&2
  exit 1
fi

major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$major" -lt 20 ]; then
  echo "error: Node.js 20+ is required, found $(node -v)" >&2
  exit 1
fi

if command -v pnpm >/dev/null 2>&1; then
  echo "==> installing dependencies with pnpm"
  pnpm install --frozen-lockfile
  echo "==> compiling TypeScript"
  pnpm run build
else
  echo "==> installing dependencies with npm"
  npm install
  echo "==> compiling TypeScript"
  npm run build
fi

if [ ! -f dist/cli/index.js ]; then
  echo "error: dist/cli/index.js was not produced" >&2
  exit 1
fi

echo "==> smoke check"
node bin/sshx.js --version

echo "==> build complete"
