# CLAUDE.md

`agent-finops` is a local-only CLI that reads Claude Code's JSONL logs and
reports token and cost aggregates. Read `SECURITY.md` for the data boundary and
`CONTRIBUTING.md` for the design constraints before changing anything.

## Commands

```sh
npm test              # node --test, the whole suite
npm run audit         # privacy audit (needs ripgrep)
npm run public-audit  # scans the candidate public tree (needs ripgrep + git)
npm run release-check # test + both audits + offline package-content check
```

`release-check` is the gate. Run it before proposing a change is finished.
Both audit scripts require `ripgrep`; they fail with an explicit message if it
is missing.

## Invariants

These are enforced by `scripts/privacy-audit.sh` and by tests. Breaking one
should fail CI — if you change one deliberately, update the audit in the same
change and say so explicitly.

- **No outbound network, no subprocesses, no telemetry, no runtime
  dependencies.** `node:http` is allowed in `src/dashboard.mjs` only, bound to
  `127.0.0.1`, with a `Host` check and a CSP that forbids browser connections.
- **Redaction runs before `JSON.parse`.** `redactSensitiveProperties` is a
  lexer, not a parser: it replaces content-bearing values without decoding
  them. Never call `JSON.parse` on a raw log line.
- **The index is metadata-only.** Persist only what `metadataRecord` in
  `src/index.mjs` allows: hashed project/session/request IDs, timestamps, model
  IDs, token counters, and allowlisted tool names. No paths, no transcript text.
  A new retained field needs a documented reason, a validation rule, and a test
  proving sensitive content stays out. Retired entries (below) hold exactly the
  same fields, and `normalizeStoredRecord` rebuilds them from that allowlist on
  every load — that is the only remaining check on a record whose log file is
  gone.
- **Tool names are allowlisted** by `SAFE_TOOL_NAME_RE` before they are stored.
- **Fingerprints are salted.** `fingerprint(value, salt)` mixes in a random
  32-byte per-install salt stored as `index.salt`. The pre-images are absolute
  paths and directory names, so an unsalted id is a confirm-or-deny oracle on a
  shared report. Thread the salt explicitly — `fingerprint` stays pure — and
  never let it reach a report, a tag payload, terminal output, or the dashboard.
- **Cost is an estimate, never an invoice.** Do not present local rates or
  follow-on attribution as billing truth or as proof of causation.

## Things that are easy to get wrong

- **Cache writes are priced by TTL.** A 5-minute write costs 1.25x the input
  rate, a 1-hour write 2x. The split lives in
  `message.usage.cache_creation.ephemeral_{1h,5m}_input_tokens`. `cacheCreate`
  is the total; `cacheCreate1h` and `cacheCreate5m` break it down and must never
  be added into `usage.total`. An unclassified remainder is charged at the
  5-minute rate so an old log cannot inflate the estimate.
- **`src/index.mjs` has a `VERSION`.** Bump it whenever the stored record shape
  or the scan state changes. `loadIndex` discards a mismatched index, which is
  what forces a rebuild rather than silently serving stale numbers — but it
  discards only what a rescan can re-derive. `tags`, `retired`, and `salt` are
  carried across every version change, because nothing can recreate them.
- **The index is durable, not a cache of the log directory.** Claude Code
  deletes its own transcripts. A source the walk no longer finds moves into
  `index.retired`, keeps counting in every report, and is deleted only by
  `prune-index`. A source that reappears replaces its retired entry, since the
  live read is ground truth and keep-last dedup absorbs any overlap. Never
  auto-prune retired history.
- **Reporting windows are half-open.** `buildReport` takes `sinceMs` inclusive
  and `untilMs` exclusive, so adjacent windows partition records instead of both
  claiming the boundary turn. `--since` and `--from`/`--to` are mutually
  exclusive by design; a bare `--from`/`--to` date is UTC midnight, matching the
  UTC day buckets.
- **Scanning is incremental.** `readClaudeRecords` resumes from a byte offset.
  It only commits progress past a line that was fully read, so a half-written
  final line is retried on the next scan instead of being skipped or counted
  twice. Records from that uncommitted line travel as `tailRecords`, stored
  apart from `records` on the file entry: reports read both, but a resumed scan
  replaces the tail instead of appending to it, because it re-reads that line. Resume only happens when a file strictly grew; equal size with a new
  mtime, or a smaller file, means it was rewritten and is re-read whole.
- **Tool attribution is a cohort, not a receipt.** A cohort opens at a tool call
  and closes at the next human prompt. The following billed turn is split
  equally among the tools in the prior message so rows sum to the unsplit total.
  Parallel tool calls stream as several JSONL lines sharing one `message.id`, so
  the cohort accumulates by message id — not per line, which would have handed
  the whole following turn to whichever block was written last — and a line never
  inherits its own siblings' tools as `priorTools`.
- **Any reporting command may rewrite the index.** `src/cli.mjs` rescans when
  `--fresh` is passed *or* when the index is older than `INDEX_MAX_AGE_MS` (one
  hour), so `report`, `dashboard`, `tools`, and the rest are not read-only on
  disk. The rewrite carries the same metadata-only content, and the docs must
  say so: describing the index as written "only by `scan`" is wrong.
- **Reports deduplicate before costing.** Streaming emits several rows per turn;
  `keepLast` collapses them on `messageId:requestId`. Any cost computed straight
  off `indexedRecords` without that dedup will roughly double.

## Testing

Use synthetic fixtures only — never commit real transcripts, prompts, tool
output, indexes, or absolute workstation paths. The suite asserts that a known
secret string never reaches the index, the report, or the dashboard; keep that
pattern when adding tests that touch ingestion.
