#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
TASK_CACHE=$(mktemp -d "${TMPDIR:-/tmp}/agent-finops-npm-cache.XXXXXX")
trap 'rm -rf "$TASK_CACHE"' EXIT

cd "$ROOT"
npm test
npm run audit
npm run public-audit
# npm run exports its own lower-case npm_config_cache. Clear it explicitly so
# this check stays self-contained even on machines whose normal npm cache is
# unreadable or owned by another user.
unset npm_config_cache
export NPM_CONFIG_CACHE="$TASK_CACHE"
npm pack --dry-run --json
