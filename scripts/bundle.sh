#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
TASK_CACHE=$(mktemp -d "${TMPDIR:-/tmp}/agent-finops-npm-cache.XXXXXX")
trap 'rm -rf "$TASK_CACHE"' EXIT

cd "$ROOT"
mkdir -p dist
unset npm_config_cache
export NPM_CONFIG_CACHE="$TASK_CACHE"
npm pack --pack-destination dist
echo "Transfer the resulting dist/agent-finops-*.tgz, extract it, then run scripts/install-local.sh."
