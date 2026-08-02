# Changelog

All notable changes are documented here. Versions use semantic versioning.

## [0.4.1] - 2026-08-02

Fixed
- Tool/MCP follow-on attribution no longer charges a tool for every later turn
  in the session. A cohort now ends at the next human prompt instead of running
  until the next tool call, which had systematically inflated tool cost.
- `report --json` and `scan --json` no longer embed absolute filesystem paths,
  which disclosed the local username in the artifact people share. `doctor`
  still prints paths.
- Introductory model pricing is applied by each turn's timestamp, so current
  Sonnet 5 usage is no longer estimated at the post-introductory rate.
- The Bash output filter keeps both ends when head and tail exceed the budget.
  Long lines previously pushed the tail out, discarding the failure summary.
- The omitted-line count counted distinct strings rather than positions and
  overstated how much output had been dropped.
- The release workflow's tag/version check contained a shell quoting error that
  made it fail on every run. It now also runs before the expensive gates.
- The public audit scans hidden files, so a credential in a dotfile is caught.
- `agent-finops projects` honours `--limit` instead of always showing eight.
- Flags given without a value now fail instead of being silently ignored.

Security
- The dashboard rejects non-loopback `Host` headers, closing a DNS-rebinding
  path that let a public site read the page as same-origin.
- Captured terminal output keys (`stdout`, `stderr`, `toolUseResult`) are
  redacted before JSON decoding.
- `hook-config` shell-quotes the checkout path instead of JSON-quoting it.

Changed
- Tool-name scanning is linear rather than quadratic in line length (~10x
  faster on large assistant records).

## [0.4.0] - 2026-08-02

- Added a loopback-only local dashboard for spend, model, tool/MCP, and session
  findings.
- Added tool/MCP cohort attribution and direct anonymous session comparisons.
- Added open-source repository health files and GitHub CI/release preparation.
