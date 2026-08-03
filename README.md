<p align="center">
  <img src="assets/favicon-ledger.svg" width="112" height="112" alt="agent-finops ledger icon">
</p>

<h1 align="center">agent-finops</h1>

<p align="center">
  <strong>Know what your coding agents cost—without sending their data anywhere.</strong>
</p>

<p align="center">
  Local-first cost analytics for Claude Code, including Amazon Bedrock usage.
</p>

`agent-finops` turns the Claude Code logs already on your machine into useful
spend signals: daily and per-model costs, run rate, project and session
breakdowns, tool/MCP cohorts, and evidence-backed savings experiments.

- **Private by construction.** Prompts, responses, reasoning, tool arguments,
  terminal output, source code, and filesystem paths never enter the index.
- **Local and inspectable.** There are no runtime dependencies, outbound network
  calls, subprocesses, or telemetry. Reports and the dashboard stay on your
  machine.
- **Built for decisions.** See where spend moved, compare matched windows, and
  rank changes by their estimated savings instead of staring at token totals.
- **Honest about uncertainty.** Every dollar figure is a local estimate—not an
  invoice—and causal claims are kept separate from observed cost cohorts.

## Quick start

Requirements: Node.js 20 or newer. Clone the repository and install a local
launcher; no package install, registry, cloud account, or elevated permissions
are required.

```sh
git clone https://github.com/YiftachCohen/agent-finops.git
cd agent-finops
./scripts/install-local.sh

agent-finops doctor
agent-finops scan
agent-finops report --since 7d
agent-finops dashboard --since 30d
```

By default, `agent-finops` reads `~/.claude/projects`. Use `--log-dir` or
`AGENT_FINOPS_LOG_DIR` for a different Claude configuration directory.

## Privacy boundary

The data boundary is deliberately narrow:

- Reads: timestamp, opaque request/message ids, model, token usage, and the
  log-file path needed to create a local session fingerprint.
- Never retains: prompts, responses, reasoning, terminal output, tool arguments,
  instructions, working-directory text, or source code.
- Writes: one private local metadata index. `scan` and any `--fresh` command
  rewrite it on demand, and any reporting command rewrites it on its own once
  the index is more than an hour old, so a spend figure is never served from a
  stale snapshot that reads like "no usage". Every write has the same
  metadata-only content: hashed project/session/request IDs, timestamps, model
  IDs, and token counters—not paths or transcript content.
- Keeps: the index is a durable store, not a cache of what is currently on
  disk. Claude Code deletes its own old transcripts; the metadata records for a
  log file that is gone are retired inside the index and keep counting, so
  history does not shrink behind you. Bound that history with
  `agent-finops prune-index --older-than 90d`, which is the only thing that
  deletes it.

The privacy gate strips content-bearing fields before JSON decoding. Run
`npm run audit` to verify that invariant and the absence of outbound network
and subprocess APIs.

## Estimation boundary

This is a cost-management tool, not an invoice. Its rate table is local and
versioned in source. The table follows Anthropic's published
[Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing) and
[prompt-caching pricing](https://platform.claude.com/docs/en/build-with-claude/prompt-caching),
last verified on 2026-08-02. Bedrock region, cross-region, negotiated, data
residency, fast-mode, and TTL-specific pricing can differ from the estimate.
Specifically:

- Cache writes are priced by TTL: 1.25x input for a 5-minute write, 2x for a
  1-hour write. Claude Code records the split, so each turn is priced with the
  TTL it actually used. A turn logged without that breakdown is charged at the
  5-minute rate, which understates rather than inflates it.
- Fast mode bills at a premium but is not distinguishable in the log, so a
  fast-mode turn is estimated at the standard rate for its model.
- Introductory pricing is applied by the timestamp on each turn, so a report
  spanning a price change prices each turn with the rate then in effect.

## Command reference

The CLI itself requires only Node.js 20 or newer. The audit scripts also require
[ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`; install it with
`brew install ripgrep` or `apt install ripgrep`). Reporting never shells out;
ripgrep is only used by `npm run audit` and `npm run public-audit`.

```sh
cd ~/projects/agent-finops
npm test
npm run audit
agent-finops scan
agent-finops report --since 7d
agent-finops report --from 2026-07-01 --to 2026-08-01
agent-finops dashboard --since 30d
agent-finops trend --days 7
agent-finops hotspots --since 24h
agent-finops tools --since 7d
agent-finops mcp --since 7d
agent-finops sessions --since 7d --limit 20
agent-finops compare-sessions SESSION_A SESSION_B --since 7d
agent-finops projects --limit 20
agent-finops project d78a771feca2 --since 7d
agent-finops label d78a771feca2 "Billing app"
agent-finops tag baseline-24h --since 24h --fresh
agent-finops compare baseline-24h boost-24h
agent-finops prune-index --older-than 90d
agent-finops hook-config
agent-finops filter-report --since 7d
agent-finops report --json > /private/tmp/agent-finops.json
agent-finops doctor
```

`--json` output contains no filesystem paths. Session and project ids are
salted per install, so a shared report neither carries a local username nor lets
a reader confirm a guessed one — and ids from two machines, or from the same
machine before and after a reinstall, cannot be lined up with each other. Run
`doctor` when you need to see which index and log directory are in use.

### Time windows

Every command that accepts `--since` also accepts `--from` and `--to`:

- `--since 7d` is relative to now (`24h`, `7d`, `2w`).
- `--from` and `--to` are absolute. Each takes a date such as `2026-07-01`,
  read as UTC midnight because day buckets are UTC, or a full ISO-8601
  timestamp such as `2026-07-01T09:30:00Z`.
- The window is `[from, to)`: the start is included and the end is excluded, so
  `--from 2026-07-01 --to 2026-08-01` is exactly July. Either bound works on
  its own — `--to` alone means everything before it.
- `--since` and `--from`/`--to` cannot be combined; that is an error, not a
  silent precedence rule.
- `trend` uses `--days` instead and is unaffected.

Use the absolute form for `tag`/`compare`: a comparison is only meaningful over
matched windows, and `compare` prints the window each snapshot was taken over.

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
files and re-reads only files that Claude Code changed. Reporting commands also
scan on their own once the index is over an hour old, which rewrites it with the
same metadata-only content; inside that hour they read the last scan as it is.
`--fresh` forces that scan now, regardless of the index's age.

A log file that has disappeared since the last scan is *retired*, not forgotten:
its metadata records stay in the index and stay in every report, and `scan` says
how many sources it retired. Claude Code prunes its own transcripts, so without
this a report would quietly lose past spend. `prune-index --older-than 90d` is
the only thing that deletes retired records; it never touches live log files,
and a retired record with no usable timestamp counts as older than any cutoff
because no window can hold it.

`report` includes:

- total, daily, and per-model input/cache-write/cache-read/output tokens;
- local USD estimate, including each cache class;
- a run rate: spend per *active* day (a day with records, not a day of the
  calendar span), what that pace comes to over 30 days, and the peak day when it
  cost at least twice the median one;
- one line setting the cache-read share of prompt *tokens* against its share of
  the *dollars*, since a cache read bills at 0.1x input and the two figures look
  like a contradiction until both denominators are named;
- the median/mean/p90 cost of a turn;
- a `What changed:` block naming the models and projects whose dollars moved
  most between the last seven complete days and the seven before them, when
  there is enough history to compare two windows;
- top projects by cost, named by their local label where one exists;
- top anonymous sessions by cost, each with the project it ran under and the
  average context it carries per turn; and
- safe tool/MCP names with their immediate follow-on turn estimate; and
- warnings for unpriced models and incomplete dedup keys.

The projection is a pace on the workload that already ran — what 30 days like
these would cost — never a forecast of the next 30, and never a bill.

## Local dashboard

Run `agent-finops dashboard --since 30d` and open the loopback URL it prints.
The command keeps running until `Ctrl-C`. The page visualizes daily spend, model
concentration, tool/MCP cohorts, anonymous sessions, projects, and the
evidence-backed cost-reduction experiments from `hotspots`. Its four readings are
token volume, run rate, the identified savings those experiments add up to, and
the cost of a turn.

Between the readings and the ranked breakdown, a *what changed* section names the
three models and three projects whose dollars moved most between the last seven
complete UTC days and the seven before them — the same trend `hotspots` reads, so
the page and its findings cannot describe different windows. It is descriptive:
where the money moved, not why it moved. Only the deltas travel to the browser,
already named by their local label, never the two underlying reports.

It binds exclusively to `127.0.0.1` (never the LAN), serves no API, has no
external assets or browser connections, and receives only aggregate metadata
already present in the private index. It also rejects any request whose `Host`
header is not loopback, so a public site cannot point its own hostname at
`127.0.0.1` and read the page as same-origin. Use `--port 0` to choose a random
local port, or `--fresh` to scan before serving.

`trend --days 7` compares the most recent seven *complete* UTC days with the
seven before them and prints daily history. Today is deliberately outside both
windows — a part-day against whole days reads as a decline every morning — and
is printed separately as a partial figure. `projects` groups the same cost by an
anonymous local project id, and `project ID` reports one of them on its own. If
you want readable names, add an explicit local label with `label`; labels store
only the id and your chosen name, never a path.

`hotspots` turns those metrics into evidence-backed next experiments, ranked by
what acting on each one is estimated to be worth. A finding carries an
`estimatedSavingsUsd` upper bound wherever a counterfactual can be defended —
re-pricing the top model's own tokens at its cheaper sibling's rate, re-pricing
1-hour cache writes at the 5-minute rate, scaling a bloated session's cache
reads to a smaller prompt, or pricing the output the local filter already
removed — and reports no figure at all where one cannot be, rather than
inventing it. The figures are ceilings on the window that already happened, not
forecasts, and never a claim about a bill. `tag` and
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

Project/session identifiers are SHA-256 prefixes derived locally from the log
path and project directory name, salted with a random 32-byte value generated on
first use and kept inside the `0600` index. They are stable on one install and
deliberately not portable: the same repository on another machine, or on this one
after the index is deleted, gets a different id.

That salt arrived in this release, so ids from an earlier version have all
changed. Project labels are keyed by the old ids and no longer match; `scan`
prints a notice when it sees a labels file that matches nothing. Nothing is
deleted — re-run `agent-finops projects` and re-apply the names with
`agent-finops label`. Tag snapshots are aggregates without record ids and are
unaffected.

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

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md),
[SECURITY.md](SECURITY.md), and the documented privacy boundary before opening
an issue or pull request. Never attach real Claude logs, prompts, tool output,
credentials, local indexes, or production billing data; synthetic examples are
enough to reproduce behavior.

## License

[MIT](LICENSE). This is an independent project and is not affiliated with or
endorsed by Anthropic.
