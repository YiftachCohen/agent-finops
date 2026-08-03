# Changelog

All notable changes are documented here. Versions use semantic versioning.

## [0.5.0] - 2026-08-02

Fixed
- A parallel tool call is no longer attributed to one of its tools alone. Claude
  Code streams each `tool_use` block of a message as its own JSONL line, and the
  cohort was rebuilt from each line in turn, so a message that called `Bash` and
  `Read` together kept only whichever block was written last and handed it the
  entire following billed turn. Every cohort was therefore a cohort of one: the
  equal split the model documents never ran, and `soloShare` — the share of a
  tool's cost that came from being the only tool called — was pinned at 100% for
  every tool. Cohorts now accumulate by `message.id`, so all the tools of one
  assistant message split the turn that follows it, and a line no longer inherits
  its own siblings' tools. The index version is bumped, so it rebuilds itself on
  the next scan rather than serving the old single-tool cohorts; retired records
  keep theirs, because the log files they came from are gone and the parallel
  calls cannot be re-derived.
- Parallel tool calls are counted once each rather than once in total. The same
  per-line reading undercounted the `calls` column: deduplication keeps the last
  streamed row of a message, so every `tool_use` block written before it was
  discarded, and a tool that appeared only on an earlier sibling line was charged
  follow-on cost with no call to divide it by — `usdPerCall` was then either
  measured against too few calls or reported as null. A record now carries its
  whole message's tool names, so one message calling `Bash` and `Read` together
  counts one call for each.
- History no longer disappears when Claude Code deletes a transcript. The index
  rebuilt itself from whatever log files the walk found, so once Claude Code
  pruned an old session on its own schedule, that session's spend vanished from
  every report and the drop read as a real one. Records for a log file that is
  gone are now retired inside the index and keep counting; a file that comes
  back is read live and replaces its retired copy rather than doubling it.
- Session and project ids are salted with a random per-install value stored in
  the 0600 index. They are short hashes of an absolute log path and a project
  directory name — low-entropy, highly structured pre-images — so an unsalted id
  let anyone holding a shared report confirm or deny a guessed username or
  repository name by hashing it. Ids are no longer portable across machines or
  reinstalls, which is the point.
- `report --json`, `hotspots --json`, `session --json`, and
  `compare-sessions --json` no longer embed the deduplicated per-turn record
  list under `diagnostics`. The shared artifact carried one row per billed turn
  — session fingerprints, timing, and token counts — where only two counters
  were ever read from it.
- An escaped property name no longer slips past the redaction denylist. A key
  written `"content"` did not match `content` as source text, but
  `JSON.parse` decoded it to the same property, so that value reached the
  decoder unredacted. Key names are now decoded before the denylist check, and
  a name whose escapes are malformed is redacted rather than guessed.
- The envelope `type` is read from the line's own top level instead of matching
  the first `"type"` anywhere in it. Claude Code writes `message` before `type`,
  so the gate had been answering with a nested content-block type: a tool result
  that captured an assistant record could contribute its tool names to the turn
  that merely reported it.
- A model id of `__proto__` no longer poisons a report. It resolved to inherited
  objects in the rate table and in every accumulator, which crashed each report
  command until the index was deleted — and the record persisted, so the crash
  survived a rescan. Rate tables and accumulators now have null prototypes, and
  tag lookups check own properties.
- Model ids and timestamps are validated at ingestion. A model id must look like
  a model id or it is stored as `<unknown>`, so an escape sequence or a
  500-character string from a log file can no longer reach the terminal, the
  index, or shared JSON; an unparseable timestamp is stored as `null`.
- `trend` compares complete UTC days only. The current window included the hours
  elapsed so far today while the previous window held whole days, so spending
  read as a decline every morning. Today's spend is now printed separately as a
  partial figure, and the JSON gains a `today` field.
- A turn read from a not-yet-terminated final line is no longer indexed twice.
  The record was stored while the resume offset stayed behind that line, so
  every later scan appended the same turn again and inflated the estimate for
  any turn missing a deduplication key.

- Cache writes are now priced by TTL. Every cache write was charged at the
  5-minute rate of 1.25x input, but a 1-hour write costs 2x, and Claude Code
  records which was used under `message.usage.cache_creation`. The estimate had
  therefore been understating real spend by up to 37.5% of all cache-write cost
  wherever a 1-hour TTL was in play. Turns logged without the breakdown are
  still charged at the 5-minute rate, which is the conservative floor.
- A log file whose read ended early is no longer recorded as fully indexed. It
  had been cached as complete until the file changed again, permanently
  under-counting it after a transient read error.

Changed
- `report` replaces `Cache-read share: 96.7% · output-cost share: 16.1%` with one
  line that names both denominators: `Cache reads are 96.7% of prompt tokens but
  53% of estimated cost — a cache read bills at 0.1x the input rate.` The old
  line sat directly under `Cost by class: cache-read $2,710.50 (53%)`, where two
  numbers describing the same class read as a contradiction unless you already
  knew one was tokens and the other dollars — which is the confusion this tool
  exists to remove. The cost figure is the one the line above already printed,
  the output share it dropped is a share of that same split, and
  `insights.cacheReadShare` and `insights.outputCostShare` are unchanged in the
  JSON, where tags and other callers read them.
- The dashboard's cost-per-turn reading is stated to three decimals rather than
  four: `$0.090`, not `$0.0902`. It now shares one helper with the tool `$/call`
  figure and with the CLI's, so a turn reads the same on both surfaces. The
  four-decimal formatter stays where it belongs — on sub-cent figures that would
  otherwise print as `$0.00`.
- The dashboard's middle two readings are now run rate and identified savings.
  Cache-read share was a share of *tokens*, which the cost-by-class legend and
  every bar on the page now state in dollars instead, and output-cost share
  repeated one segment of that same split. What replaced them is what an operator
  acts on: what this window costs per active day, and what the ranked findings
  below are worth in total if every one of them is acted on. Token volume and
  cost per turn are unchanged. Either new reading falls back to a dash and a
  neutral note on legacy or tag-shaped data rather than inventing a figure.
- The index version is bumped once for the uncommitted-tail split, the retired
  section, the new salt, and the message-grouped tool cohort — whose resume state
  replaces `pendingTools` with `cohortTools`, `currentTools`, and a salted
  `messageGroup` — so an existing index is rebuilt once on the next
  scan rather than serving numbers that were produced by the duplicating code
  path — and everyone re-fingerprints exactly once. A version change now also
  means something more precise: records cached for a log file that still exists
  are discarded and rebuilt from that file, while tag snapshots, retired
  records, and the salt are carried across untouched, because nothing can
  re-derive them.
- Existing project labels keyed by the old, unsalted ids no longer match any
  project. They are not deleted; `scan` prints a one-line notice when a labels
  file matches nothing. Re-run `agent-finops projects` and re-apply the labels.
- Each reporting command aggregates the index once. Every command built a full
  default report and then discarded it to build its own; `compare-sessions`
  aggregated the whole corpus three times.

Added
- The repository is ready for its public release under the MIT license. Package
  metadata now links back to the canonical repository and issue tracker, the
  README has a working fresh-clone installation path and published pricing
  provenance, and the release gate scans reachable Git history instead of only
  the latest tree before approving a public artifact.
- The dashboard and `report` say what changed, not just that something did. The
  headline stated that spend rose against the previous period and stopped there,
  leaving the operator's next question — "driven by what?" — to a separate
  command, even though `analyzeTrend` already ranked the per-model and
  per-project dollar deltas that answer it. The page gains a *what changed*
  section between the readings and the ranked breakdown, listing the three
  models and three projects whose dollars moved most, with direction carried by
  a leading sign and a step of ink rather than by a hue the monochrome page does
  not have. `humanReport(report, labels, trend)` prints the same block, two rows
  a side, directly under the run rate; the third argument is optional, so every
  existing caller is unchanged. Both surfaces read the fixed seven-day pair the
  hotspot rules already read, state the two windows they compared, and say that
  a row is where the money moved and not why it moved. With too little history
  to build a second window the section renders its empty state rather than
  disappearing, and the terminal block is simply absent.
- `report` states a run rate. `insights.runRate` carries spend per active day,
  the days it was measured over, the first and last of them, what that pace comes
  to over 30 days, and the peak day against the median one; `report` prints it
  directly under the estimate and names the peak day when it cost at least twice
  the median. "Active day" means a day that has records, not a day of the
  calendar span: a month worked on twelve days is a twelve-day rate, because
  averaging in the days nobody ran the agent describes a workload that was not
  running. The projection is a pace on the window that already happened, never a
  forecast and never a bill. A window with no dated record has no rate and prints
  no line.
- `report` lists projects, between the models and the sessions, ranked by
  estimated cost and named by the local label where `agent-finops label` has
  given an id one. `buildReport` already computed `topProjects`, and for anyone
  running several agent workspaces at once it is the strongest reading of where
  the money went; the report never showed it.
- `report` prints the median, mean, and p90 cost of a turn beside the cache and
  output shares. `insights.perTurnUsd` existed and only the dashboard read it,
  so the gap between the turn most of a window looks like and the turn its
  average describes was invisible in the terminal.
- Session rows in `report` and `sessions` carry the project they ran under and
  the average context they haul into each turn, beside the cost, tokens, and turn
  count they already had. A bare fingerprint and a dollar figure is not something
  anyone can act on; "expensive session, in this project, running 331K contexts"
  is the diagnosis. `humanReport(report, labels)` and `humanSessions(sessions,
  labels)` take the label map as an optional second argument, so a caller with no
  labels file passes nothing.
- Tool/MCP rows now carry per-use economics and attribution confidence instead
  of only ranking by ubiquity. `usdPerCall` (usd / calls, null with no counted
  call) and `soloShare` (the fraction of a tool's attributed cost that came
  from a cohort where it was the only tool called, null with no priced cost)
  appear in `report --json`, `agent-finops tools`, and the dashboard's tool
  row detail. A tool that is always in the mix but rarely the only one — Bash
  is the usual case — now reads as a low, diluted solo share next to one that
  is almost always billed alone.
- Every bucket now carries its estimate split into the four charged classes —
  input, cache write, cache read, and output — and both surfaces read from it.
  `report` prints a `Cost by class:` line ranked by dollars beside the token
  line, with the share of cache-write cost bought at the 1-hour rate; the
  dashboard shades every ranking bar and every day of the strip by the same
  split and legends it in dollars. Tokens and dollars rank differently — a cache
  read costs 0.1x input and a 1-hour write 2x — so the class that dominates the
  token count is routinely not the one paying for the window.
- `report.insights.perTurnUsd` reports the mean, median, and p90 cost of a
  priced turn, and the dashboard's `cost per turn` reading leads with the median
  and carries the other two beneath it. A handful of very large turns pulled the
  mean well above the turn most windows actually consist of.
- `hotspots` recommendations now carry the number the decision turns on.
  Model concentration re-prices the top model's own tokens at its cheaper
  sibling's rate and states the difference as an explicit upper bound rather
  than a promise; a new `context-bloat` finding names the one session whose
  per-turn context is why it is expensive; and an expensive `Bash` cohort points
  at this tool's own PostToolUse filter, quoting what the local ledger has
  already removed when the hook has run.
- `hotspots` ranks its findings by what acting on them is estimated to be worth.
  Every recommendation carries `estimatedSavingsUsd` — the honest upper bound of
  acting on it, or `null` where no counterfactual can be defended — and the list
  is sorted by it, unquantified findings last, ties broken by severity and then
  by rule order. The analysis also carries `totalEstimatedSavingsUsd`, and
  `hotspots` leads with it. Four rules quantify: model concentration re-prices
  the top model's tokens at its cheaper sibling's rate; `cache-ttl` prices the
  1-hour premium at the 5-minute rate; `context-bloat` scales the session's
  cache-read dollars to a 150K-token prompt; and `bash-output-filter` prices the
  tokens the local filter has actually removed as the cache write they would
  have become. The rest report `null` rather than invent a counterfactual: an
  MCP cohort is correlation, shorter output is a different answer rather than
  the same one for less, and a spend increase may simply be more work. Every
  figure is a ceiling on the window that already happened, not a forecast.
- The always-positive cache verdict is replaced by the TTL question. Comparing
  cache-write cost against what the reads would have cost uncached returned the
  same answer — "caching is net positive" — for every agent workload, because a
  cache read is billed at a tenth of the input rate and an agent re-reads its
  context on every turn; a rule whose verdict never varies ranks nothing. The
  new `cache-ttl` finding reports the decision that does vary: what share of the
  cache-write bill was bought at the 1-hour rate (2x input) rather than the
  5-minute one (1.25x), and what the difference is worth. It presents both
  directions, because this is a tradeoff rather than a defect — a 1-hour write
  costs 60% more, but a 5-minute entry that expires between turns is re-written
  in full, and one re-write costs more than the premium saved — so the lever is
  session cadence, not a flag to flip. The old token-share reading survives as
  `cache-efficiency` for a window whose per-class dollars are missing, or whose
  cache bill is large but already mostly 5-minute writes.
- `session-outlier` and `context-bloat` no longer both name the top session. The
  two are one diagnosis each: when context bloat claims a session, it is the
  only finding raised for it, and `session-outlier` is left for the genuinely
  different case — an expensive session whose per-turn context is normal, which
  is a session made expensive by how many turns it ran rather than how heavy
  each one was. Its evidence now says so, with the turn count and the average
  prompt size that separate the two readings.
- `hotspotAnalysis(report, extras)` takes optional context a report cannot hold
  on its own — the filter ledger and a trend over the same records — and the
  `hotspots` and `dashboard` commands supply both. Every rule that reads them
  degrades to silence when they are absent, so a machine with neither still gets
  the full set of report-only findings. A window up by half or more on the
  previous one, on real money, is reported as `spend-acceleration` with the
  model that moved most.
- `trend` attributes its change: `drivers.byModel` and `drivers.byProject` list
  the largest per-key dollar deltas between the two windows, and `humanTrend`
  prints the top three of each under `Largest drivers:`. Model coverage is
  complete; project coverage is whatever ranked highest in either window, which
  is the only per-project breakdown a report carries. These are descriptive
  deltas — where the money moved, not why.
- The dashboard has a `projects` view alongside models, tools, and sessions, and
  names each row with the local label from `agent-finops label` when one exists.
  Session rows now state the project they ran under and the average prompt size
  per turn, which is the tell for context bloat.
- `agent-finops project PROJECT_ID` reports one project on its own, the way
  `session` does for one session, and heads the report with its local label.
- `--from` and `--to` set an absolute reporting window on every command that
  accepts `--since`. Both take a date such as `2026-07-01` (UTC midnight) or a
  full ISO-8601 timestamp, and the window is `[from, to)` — start included, end
  excluded — so `--from 2026-07-01 --to 2026-08-01` is exactly July. The
  tag/compare workflow asks for matched windows and, with only durations
  relative to now, an exactly matched window could not be expressed. Combining
  `--since` with `--from`/`--to` is an error rather than a silent precedence
  rule, a tag records the window it was taken over, and `compare` prints both.
- `agent-finops prune-index --older-than 90d` bounds retired history. It drops
  retired records past the cutoff — records with no usable timestamp count as
  older than any cutoff — and reports what it removed. Nothing is pruned
  automatically: silently deleting the only surviving evidence of past spend is
  the failure the retired section exists to prevent.
- `npm run check` runs `node --check` over every source and test file, and
  `release-check` runs it first: a syntax error in a file no test imports used
  to ship green.
- Adversarial tests for the controls that had none: dashboard HTML escaping,
  the loopback `Host` rule, artifact-id and retention validation, index file
  mode and corrupt-index recovery, tag and label rejection, every hotspot
  threshold, and the CLI duration/limit parsers.
- The README and `CLAUDE.md` now state that any reporting command rewrites the
  index once it is over an hour old. The README had described the index as
  created only by `scan`, `report --fresh`, or `tag --fresh`.
- `scan` reads a growing session file from where the previous scan stopped
  instead of re-reading it whole. Claude Code appends to a session for as long
  as it is open, so every active file was previously re-parsed in full on every
  scan. `scan` reports the number of files appended alongside parsed and reused.
- The redaction denylist covers the rest of the tool-result envelope
  (`filePath`, `structuredPatch`, `prompt`, `query`, `results`, and others).
  These rows are already rejected before decoding; the denylist is the backstop
  if that envelope ever changes, and the privacy audit now asserts it.
- `CLAUDE.md` records the invariants an agent working in this repository must
  not break.
- CI additionally runs on Node 24.
- The dashboard has a favicon: the register strip frozen to three readings and
  the rule that closes them. It travels inline in the page as a `data:` URI, so
  there is still exactly one route and no file read at runtime. The CSP gained
  `img-src data:`, which no more than admits an inert inline image, and the
  privacy audit now asserts both that the favicon stays a data URI and that the
  policy stays that narrow. The audit's no-URL rule gained one exact exemption
  for the SVG namespace name, which an XML-parsed data URI cannot omit and no
  browser resolves; a real network call sharing that line still fails the audit.
  The artwork and a size preview live in `assets/`.

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
