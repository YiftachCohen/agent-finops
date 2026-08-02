#!/usr/bin/env bash
set -euo pipefail

if ! command -v rg >/dev/null 2>&1; then
  echo 'privacy audit needs ripgrep (rg): brew install ripgrep, or apt install ripgrep.' >&2
  exit 1
fi

# One URL is allowed in src: the SVG namespace name in the inline dashboard
# favicon. It is an identifier, not an address — no browser or XML parser ever
# resolves it — and an XML-parsed data URI cannot omit it. Everything else that
# looks like a URL or a network API still fails. The `|| true` keeps `set -e`
# from firing on ripgrep's "no matches" exit, which is the passing case.
# Delete the allowed token from each hit and re-check what is left, rather than
# dropping the whole line: a real `fetch(` sharing a line with the namespace
# still fails.
network_hits="$(rg -n -e 'fetch|https?:|node:net|node:https|WebSocket|XMLHttpRequest' src \
  | sed 's|xmlns="http://www\.w3\.org/2000/svg"||g' \
  | rg -e 'fetch|https?:|node:net|node:https|WebSocket|XMLHttpRequest' || true)"
if [ -n "$network_hits" ]; then
  printf '%s\n' "$network_hits"
  echo 'privacy audit failed: outbound network API or URL found in src' >&2
  exit 1
fi

# The allowance above is exact, so it cannot widen by accident: the favicon must
# still be an inert inline data URI, not a fetched file.
if ! rg -n 'data:image/svg\+xml' src/dashboard.mjs >/dev/null || ! rg -n "img-src data:;" src/dashboard.mjs >/dev/null; then
  echo 'privacy audit failed: dashboard favicon must be an inline data URI under an img-src data: policy' >&2
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

# The envelope filter rejects tool-result rows before decoding, but the redaction
# denylist is the backstop if that schema ever changes. Keep them independent.
for key in toolUseResult stdout stderr structuredPatch prompt; do
  if ! rg -n "\"$key\"," src/records.mjs >/dev/null; then
    echo "privacy audit failed: captured-output key '$key' is missing from the redaction denylist" >&2
    exit 1
  fi
done

echo 'privacy audit passed: no outbound network, no subprocesses, redaction gate, safe tool-name allowlist, and loopback dashboard boundary present'
