#!/usr/bin/env bash
# Build sshx from a clean checkout.
# Usage: bash scripts/build.sh
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
  echo "error: node is required (Node.js 22.12+)" >&2
  exit 1
fi

if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 12) ? 0 : 1)'; then
  echo "error: Node.js 22.12+ is required, found $(node -v)" >&2
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
