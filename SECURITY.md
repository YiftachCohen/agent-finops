# Local data and security model

## Reporting a vulnerability

Report vulnerabilities through [GitHub Private Vulnerability Reporting](https://github.com/YiftachCohen/agent-finops/security/advisories/new).
Reports go directly to the repository maintainer. Do not open a public issue or
attach logs, indexes, credentials, prompts, or tool output. Until private
reporting is enabled, use the private contact method published on the
[maintainer's GitHub profile](https://github.com/YiftachCohen).

## Supported versions

Security fixes are applied to the latest release. Upgrade before reporting a
problem that is already resolved on `main`.

## Default commands

`scan`, `report`, `trend`, `hotspots`, `projects`, `tag`, and `compare` read
Claude Code JSONL files locally. Before parsing assistant records, the parser
replaces known content-bearing JSON fields with `null`. The persistent index is
`~/.local/share/agent-finops/index.json`, mode `0600`; it contains only hashed
project/session/request identifiers, timestamps, model IDs, token counters, and
safe tool names. Tool names must match a restricted identifier grammar. Tool
arguments, results, ids, prompts, response text, and paths are never retained.

Project and session identifiers are salted hashes. The random per-install salt
lives inside that same `0600` index file and is never printed, exported in
`--json`, stored in a tag snapshot, or sent to the dashboard page. Anyone who
can read the index can already read the whole local usage history; the salt's
job is to stop a *shared report* from being used to confirm a guessed username
or repository name against a bare hash.

`--show-project-names` is an explicit local-display exception. It derives the
Claude project-directory identifier from a currently live log path in memory
for that command only. It is never written to the index or tags and is rejected
with `--json`; dashboard output in this mode must not be screenshot or shared.

The program has no outbound network code, no subprocess calls, no telemetry,
and no runtime dependencies. It does not read AWS credentials or invoke Bedrock.

## Local dashboard

`agent-finops dashboard` is a deliberately narrow exception to the no-network
boundary: it starts a one-page HTTP server bound only to `127.0.0.1`. It exposes
no API endpoints, reads no additional files, makes no outbound connection, and
sends a page containing only the same aggregate metadata displayed by the CLI.
Its Content Security Policy forbids browser connections and third-party assets.
The only image source it permits is `data:`, which covers the favicon carried
inline in the page and cannot resolve to anything off the machine.
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
