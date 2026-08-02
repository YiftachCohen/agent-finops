#!/usr/bin/env bash
set -euo pipefail

PREFIX=${AGENT_FINOPS_PREFIX:-"$HOME/.local"}
TARGET="$PREFIX/bin/agent-finops"

if [ -L "$TARGET" ]; then
  rm "$TARGET"
  echo "Removed local launcher: $TARGET"
else
  echo "No agent-finops launcher at $TARGET"
fi
