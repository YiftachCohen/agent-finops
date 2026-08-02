# Local data and security model

## Reporting a vulnerability

When this repository is public, report vulnerabilities through GitHub Private
Vulnerability Reporting. Do not open a public issue or attach logs, indexes,
credentials, prompts, or tool output. Until that GitHub setting is enabled,
contact a maintainer privately through GitHub.

## Default commands

`scan`, `report`, `trend`, `hotspots`, `projects`, `tag`, and `compare` read
Claude Code JSONL files locally. Before parsing assistant records, the parser
replaces known content-bearing JSON fields with `null`. The persistent index is
`~/.local/share/agent-finops/index.json`, mode `0600`; it contains only hashed
project/session/request identifiers, timestamps, model IDs, token counters, and
safe tool names. Tool names must match a restricted identifier grammar. Tool
arguments, results, ids, prompts, response text, and paths are never retained.

The program has no outbound network code, no subprocess calls, no telemetry,
and no runtime dependencies. It does not read AWS credentials or invoke Bedrock.

## Local dashboard

`agent-finops dashboard` is a deliberately narrow exception to the no-network
boundary: it starts a one-page HTTP server bound only to `127.0.0.1`. It exposes
no API endpoints, reads no additional files, makes no outbound connection, and
sends a page containing only the same aggregate metadata displayed by the CLI.
Its Content Security Policy forbids browser connections and third-party assets.
Stop it with `Ctrl-C`.

## Optional output-reduction hook

The `PostToolUse` hook is disabled unless you explicitly merge its configuration
into Claude Code settings. When enabled, it may retain full Bash stdout/stderr at
`~/.local/share/agent-finops/filter/artifacts`, mode `0600`, so compressed output
can be retrieved. This is the only feature that persists raw content. Use
`agent-finops prune --older-than 7d` to enforce a retention period.

## Work-laptop review checklist

- Run `npm run release-check` from a trusted checkout before transfer.
- Verify the package contains only the allowlisted files printed by the release
  check.
- Use the supplied user-local installer; do not run with elevated privileges.
- Run `agent-finops doctor` after installation.
- Review and explicitly approve the hook configuration before enabling it.
