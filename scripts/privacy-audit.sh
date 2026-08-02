#!/usr/bin/env bash
set -euo pipefail

if ! command -v rg >/dev/null 2>&1; then
  echo 'privacy audit needs ripgrep (rg): brew install ripgrep, or apt install ripgrep.' >&2
  exit 1
fi

if rg -n -e 'fetch|https?:|node:net|node:https|WebSocket|XMLHttpRequest' src; then
  echo 'privacy audit failed: outbound network API or URL found in src' >&2
  exit 1
fi

if rg -l 'node:http' src | rg -vx 'src/dashboard.mjs'; then
  echo 'privacy audit failed: only the local dashboard may use node:http' >&2
  exit 1
fi

if ! rg -n 'host: LOOPBACK_HOST' src/dashboard.mjs >/dev/null || ! rg -n "connect-src 'none'" src/dashboard.mjs >/dev/null; then
  echo 'privacy audit failed: dashboard must bind to loopback and forbid browser connections' >&2
  exit 1
fi

if ! rg -n 'isLoopbackHost' src/dashboard.mjs >/dev/null; then
  echo 'privacy audit failed: dashboard must reject non-loopback Host headers (DNS rebinding)' >&2
  exit 1
fi

if rg -n -e 'node:child_process|spawn\(|execFile\(' src; then
  echo 'privacy audit failed: subprocess API found in src' >&2
  exit 1
fi

if ! rg -n 'redactSensitiveProperties\(raw' src/records.mjs >/dev/null; then
  echo 'privacy audit failed: Claude lines must be redacted before JSON.parse' >&2
  exit 1
fi

if rg -n 'JSON\.parse\(raw' src; then
  echo 'privacy audit failed: raw Claude lines must never be JSON-decoded' >&2
  exit 1
fi

if ! rg -n 'SAFE_TOOL_NAME_RE' src/records.mjs >/dev/null; then
  echo 'privacy audit failed: tool names need an allowlist before persistence' >&2
  exit 1
fi

echo 'privacy audit passed: no outbound network, no subprocesses, redaction gate, safe tool-name allowlist, and loopback dashboard boundary present'
