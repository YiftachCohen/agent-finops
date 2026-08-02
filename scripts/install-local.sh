#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PREFIX=${AGENT_FINOPS_PREFIX:-"$HOME/.local"}
TARGET="$PREFIX/bin/agent-finops"

if ! command -v node >/dev/null 2>&1; then
  echo "agent-finops needs Node.js 20 or newer." >&2
  exit 1
fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "agent-finops needs Node.js 20 or newer; found $(node --version)." >&2
  exit 1
fi

mkdir -p "$PREFIX/bin"
ln -sfn "$ROOT/src/cli.mjs" "$TARGET"
echo "Installed local launcher: $TARGET"
case ":$PATH:" in
  *":$PREFIX/bin:"*) ;;
  *) echo "Add $PREFIX/bin to PATH to run: agent-finops doctor" ;;
esac
