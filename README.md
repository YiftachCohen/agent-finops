# agent-finops

`agent-finops` is an owned, local-only CLI for understanding the cost of coding
agents. It reads the local Claude Code JSONL logs already on disk, strips all
content-bearing fields before JSON decoding, and prints aggregate token and cost
reports. It has no outbound network code, subprocesses, dependencies, or telemetry.

The default data boundary is deliberately narrow:

- Reads: timestamp, opaque request/message ids, model, token usage, and the
  log-file path needed to create a local session fingerprint.
- Never retains: prompts, responses, reasoning, terminal output, tool arguments,
  instructions, working-directory text, or source code.
- Writes: one private local metadata index, created only by `scan`, `report
  --fresh`, or `tag --fresh`. It contains hashed project/session/request IDs,
  timestamps, model IDs, and token counters—not paths or transcript content.

This is a cost-management tool, not an invoice. Its rate table is local and
versioned in source. Bedrock region, cross-region, negotiated, and TTL-specific
pricing can differ from the estimate. Specifically:

- Cache writes are priced at the 5-minute TTL (1.25x input). A 1-hour TTL costs
  2x, and the JSONL does not record which TTL a turn used.
- Fast mode bills at a premium but is not distinguishable in the log, so a
  fast-mode turn is estimated at the standard rate for its model.
- Introductory pricing is applied by the timestamp on each turn, so a report
  spanning a price change prices each turn with the rate then in effect.

## Open source and contributing

Contributions are welcome once the public repository is released. Read
[CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md) before opening
an issue or pull request. Never attach real Claude logs, prompts, tool output,
credentials, local indexes, or production billing data; synthetic examples are
enough to reproduce behavior.

## Install and use

Requirements: Node.js 20 or newer for the CLI itself, plus
[ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`) for the audit scripts
(`brew install ripgrep` or `apt install ripgrep`). Reporting never shells out;
ripgrep is only used by `npm run audit` and `npm run public-audit`.

```sh
cd ~/projects/agent-finops
npm test
npm run audit
agent-finops scan
agent-finops report --since 7d
agent-finops dashboard --since 30d
agent-finops trend --days 7
agent-finops hotspots --since 24h
agent-finops tools --since 7d
agent-finops mcp --since 7d
agent-finops sessions --since 7d --limit 20
agent-finops compare-sessions SESSION_A SESSION_B --since 7d
agent-finops projects --limit 20
agent-finops label d78a771feca2 "Billing app"
agent-finops tag baseline-24h --since 24h --fresh
agent-finops compare baseline-24h boost-24h
agent-finops hook-config
agent-finops filter-report --since 7d
agent-finops report --json > /private/tmp/agent-finops.json
agent-finops doctor
```

By default it reads `~/.claude/projects`. Use `--log-dir` or
`AGENT_FINOPS_LOG_DIR` for a different Claude configuration directory.

`--json` output contains no filesystem paths, so a report can be shared without
disclosing a local username. Run `doctor` when you need to see which index and
log directory are in use.

### Deploy on a work laptop

No registry, cloud account, or dependency install is required. Copy a checked-out
release directory to the laptop, then run:

```sh
cd agent-finops
./scripts/install-local.sh
agent-finops doctor
agent-finops scan
```

The installer creates only `~/.local/bin/agent-finops`, a symlink to the copied
checkout. Set `AGENT_FINOPS_PREFIX` to use another user-owned prefix. It requires
Node.js 20 or newer and never uses `sudo`. To remove the launcher later, run
`./scripts/uninstall-local.sh` from the same checkout. `npm run release-check`
runs tests, the privacy audit, and an offline package-content check before you
transfer a release.

To transfer a small release artifact instead of a Git checkout, run `npm run
bundle`; copy `dist/agent-finops-*.tgz` to the laptop, extract it, enter the
resulting `package` directory, then run `./scripts/install-local.sh`.

## Reports

Run `scan` to incrementally update the local index. It reuses unchanged log
files and re-reads only files that Claude Code changed. `report --fresh` scans
first; a plain `report` deliberately uses the last local scan.

`report` includes:

- total, daily, and per-model input/cache-write/cache-read/output tokens;
- local USD estimate, including each cache class;
- cache-read share and output-cost share;
- top anonymous sessions by cost; and
- safe tool/MCP names with their immediate follow-on turn estimate; and
- warnings for unpriced models and incomplete dedup keys.

## Local dashboard

Run `agent-finops dashboard --since 30d` and open the loopback URL it prints.
The command keeps running until `Ctrl-C`. The page visualizes daily spend, model
concentration, tool/MCP cohorts, anonymous sessions, cache/output shares, and
the evidence-backed cost-reduction experiments from `hotspots`.

It binds exclusively to `127.0.0.1` (never the LAN), serves no API, has no
external assets or browser connections, and receives only aggregate metadata
already present in the private index. It also rejects any request whose `Host`
header is not loopback, so a public site cannot point its own hostname at
`127.0.0.1` and read the page as same-origin. Use `--port 0` to choose a random
local port, or `--fresh` to scan before serving.

`trend --days 7` compares the most recent seven calendar days with the seven
before them and prints daily history. `projects` groups the same cost by an
anonymous local project id. If you want readable names, add an explicit local
label with `label`; labels store only the id and your chosen name, never a path.

`hotspots` turns those metrics into evidence-backed next experiments. `tag` and
`compare` create private snapshots so changes such as Boost, a custom terminal
filter, a cache policy, or a routing rule can be evaluated against comparable
time windows. The comparison is descriptive: it does not pretend that two
unmatched days prove causality.

## MCP and session attribution

`tools` lists every observed tool name; `mcp` limits that list to conventional
`mcp__server__tool` names. For each row it reports call count and an estimated
cost/token count for the immediately following billed assistant turn. If a
message called several tools, that following turn is split equally among them,
so all tool rows add up rather than double-counting a turn. This identifies
costly **cohorts** such as a wide MCP schema or oversized result, but it is not
an invoice line item and cannot prove a tool caused all following cost.

A cohort spans only the tool call and the turns that answer it. A new human
prompt ends the cohort, so turns you type after a tool ran are not charged to
that tool.

Only a tool's safe name is retained—never its arguments, result, tool id,
prompt, or working-directory path. Existing indexes are automatically rebuilt
once after this version so they gain the new metadata.

`sessions` lists anonymous session ids with estimated cost and tokens. Use
`session ID` for the model/cache/tool breakdown of one session, or
`compare-sessions LEFT_ID RIGHT_ID` to compare two exact sessions in the same
time range.

## Opt-in Bash output reduction

The metering commands do not alter Claude Code. The optional hook below is the
cost-reduction feature: it deterministically reduces long, noisy Bash `stdout`
*after the command executes* and before the result returns to Claude. It never
changes `stderr`, images, or short output. It preserves head/tail lines and
diagnostic lines (`error`, `fail`, `warning`, etc.). When even the head and tail
exceed the budget, the middle is cut and both ends are kept, because the end of
a build or test run is where the failure summary lives.

When it reduces output, the full original stdout/stderr is retained locally under
`~/.local/share/agent-finops/filter/artifacts`, mode `0600`, and Claude receives
an artifact id it can ask to retrieve. This raw-artifact store is separate from
the metadata-only index. Remove retained artifacts with `prune`.

Generate the exact hook configuration for this checkout:

```sh
./src/cli.mjs hook-config
```

Merge that `PostToolUse` entry into the desired Claude Code settings file. Do not
blindly replace an existing `hooks` object. The hook is intentionally **not**
installed automatically, because it changes what Claude sees.

After a session using the hook:

```sh
./src/cli.mjs filter-report --since 24h
./src/cli.mjs artifact ARTIFACT_ID   # prints full local output on demand
./src/cli.mjs prune --older-than 7d
```

Measure a matching baseline and treatment window with `tag`/`compare` before
declaring that output reduction helped overall cost or task success.

Project/session identifiers are stable SHA-256 prefixes derived locally. They
are useful for grouping cost without placing a path in normal report output.

## Privacy audit

Run `npm run audit`. The audit verifies that the source tree has no network or
subprocess APIs and that the redaction gate runs before `JSON.parse`. Tests also
prove that raw content and raw request/message IDs never reach the metadata
index. Review the code and run it from source; that is the intended deployment
model for a corporate environment.

Before a public release, run `npm run public-audit` as well. It checks the
candidate Git tree (including untracked non-ignored files before an initial
commit) for local indexes/logs, release artifacts, common credential formats,
private keys, and absolute user-home paths.

## Deliberate first boundary

This first release measures Claude Code logs, including Claude Code running over
Amazon Bedrock. It intentionally does **not** call AWS. A later optional
`reconcile aws` adapter can be added behind an explicit opt-in, using only your
corporate AWS credentials and aggregate billing data. It should never require raw
Bedrock invocation request/response logging.
