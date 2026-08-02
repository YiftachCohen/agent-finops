import { canonicalModelId, cheaperSiblingModel, costFor, priceUsage } from "./rates.mjs";

const EMPTY_USAGE = () => ({ input: 0, cacheCreate: 0, cacheCreate1h: 0, cacheCreate5m: 0, cacheRead: 0, output: 0, total: 0 });

function addUsage(target, usage) {
  target.input += usage.input;
  target.cacheCreate += usage.cacheCreate;
  // The per-TTL fields break `cacheCreate` down rather than adding to it, so
  // they are summed for reporting but deliberately excluded from `total`.
  target.cacheCreate1h += usage.cacheCreate1h || 0;
  target.cacheCreate5m += usage.cacheCreate5m || 0;
  target.cacheRead += usage.cacheRead;
  target.output += usage.output;
  target.total += usage.input + usage.cacheCreate + usage.cacheRead + usage.output;
}

const EMPTY_USD_BY_CLASS = () => ({ input: 0, cacheWrite: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 0 });

function addUsdByClass(target, usdByClass) {
  // Absent on an unpriced record and on any cost produced before this field
  // existed; the bucket stays zeroed rather than reporting a share it cannot
  // support.
  if (!usdByClass) return;
  target.input += usdByClass.input || 0;
  target.cacheWrite += usdByClass.cacheWrite || 0;
  // Breakdown of `cacheWrite`, so summed for reporting but never added into it.
  target.cacheWrite1h += usdByClass.cacheWrite1h || 0;
  target.cacheWrite5m += usdByClass.cacheWrite5m || 0;
  target.cacheRead += usdByClass.cacheRead || 0;
  target.output += usdByClass.output || 0;
}

function bucket() {
  return { usage: EMPTY_USAGE(), usd: 0, outputUsd: 0, usdByClass: EMPTY_USD_BY_CLASS(), requests: 0, unpricedTokens: 0 };
}

function addRecord(target, record, cost) {
  addUsage(target.usage, record.usage);
  target.requests++;
  if (cost.priced) {
    target.usd += cost.usd;
    target.outputUsd += cost.outputUsd;
    addUsdByClass(target.usdByClass, cost.usdByClass);
  }
  else target.unpricedTokens += record.usage.input + record.usage.cacheCreate + record.usage.cacheRead + record.usage.output;
}

// Splitting a turn across the tools that preceded it yields fractional token
// counts. They are kept exact so tool rows still sum to the unsplit total, and
// rounded only where they are rendered.
const tokenFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function attributedRecord(record, divisor) {
  if (divisor <= 1) return record;
  return {
    ...record,
    usage: Object.fromEntries(Object.entries(record.usage).map(([key, value]) => [key, value / divisor])),
  };
}

function attributedCost(cost, divisor) {
  if (divisor <= 1 || !cost.priced) return cost;
  const split = { ...cost, usd: cost.usd / divisor, outputUsd: cost.outputUsd / divisor };
  if (cost.usdByClass) split.usdByClass = Object.fromEntries(Object.entries(cost.usdByClass).map(([key, value]) => [key, value / divisor]));
  return split;
}

function toolBucket() {
  // `soloUsd`/`soloFollowOnRequests` accumulate only the cohorts where this
  // tool was the sole prior tool: the strongest correlation the cohort model
  // can produce, since a shared cohort's turn is an equal split with whatever
  // else was called in the same message. `usd` and `followOnRequests` keep
  // counting every cohort, solo or shared, so tool rows still sum to the
  // unsplit total.
  return { ...bucket(), calls: 0, followOnRequests: 0, soloUsd: 0, soloFollowOnRequests: 0 };
}

function datedBucketKey(timestamp) {
  const time = Date.parse(timestamp || "");
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : "<unknown-date>";
}

/**
 * Nearest-rank percentile over an ascending list: the smallest sample at or
 * above the requested share. No interpolation, so every figure reported is a
 * turn that actually happened rather than a blend of two.
 */
function percentileOf(sorted, share) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(share * sorted.length) - 1))];
}

/** Summarize per-turn dollars as three numbers; the sample itself is discarded. */
function turnDistribution(turnUsd) {
  if (!turnUsd.length) return null;
  const sorted = [...turnUsd].sort((a, b) => a - b);
  return {
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    p50: percentileOf(sorted, 0.5),
    p90: percentileOf(sorted, 0.9),
  };
}

function keepLast(records) {
  const kept = new Map();
  let missingIds = 0;
  let duplicatesDropped = 0;
  for (const record of records) {
    const key = record.messageId && record.requestId ? `${record.messageId}:${record.requestId}` : `unique:${missingIds++}`;
    if (kept.has(key)) duplicatesDropped++;
    kept.set(key, record);
  }
  return { records: [...kept.values()], duplicatesDropped, missingIds };
}

/**
 * Aggregate a bounded list of metadata-only accounting records. The window is
 * half-open — `sinceMs` inclusive, `untilMs` exclusive — so two adjacent windows
 * partition the records instead of both claiming the turn on the boundary.
 */
export function buildReport(rawRecords, { sinceMs = null, untilMs = null, sessionLimit = 8, toolLimit = 20, projectLimit = 8 } = {}) {
  const dated = rawRecords.filter((record) => {
    if (sinceMs == null && untilMs == null) return true;
    const timestamp = Date.parse(record.timestamp || "");
    if (!Number.isFinite(timestamp)) return false;
    if (sinceMs != null && timestamp < sinceMs) return false;
    return untilMs == null || timestamp < untilMs;
  });
  const dedup = keepLast(dated);
  const all = bucket();
  // Every key below comes from a log file: a model id, a fingerprint, or a tool
  // name. On a plain object, `byModel["__proto__"] ||= bucket()` would read the
  // inherited prototype, find it truthy, and then crash accumulating into it.
  // These are serialized, so they are null-prototype objects rather than Maps.
  const byModel = Object.create(null);
  const bySession = Object.create(null);
  const byProject = Object.create(null);
  const byDay = Object.create(null);
  const byTool = Object.create(null);
  // The project a session belongs to. One log file is one session under one
  // project directory, so a session cannot span projects; if two records
  // disagree the first seen wins rather than the last.
  const sessionProject = Object.create(null);
  // Per-turn dollars, kept as a bare list of numbers so the distribution can be
  // described without the record list surviving this function.
  const pricedTurns = [];
  for (const record of dedup.records) {
    const cost = costFor(record);
    if (cost.priced) pricedTurns.push(cost.usd);
    addRecord(all, record, cost);
    const model = canonicalModelId(record.model) || "<unknown>";
    byModel[model] ||= bucket();
    bySession[record.source] ||= bucket();
    if (!(record.source in sessionProject)) sessionProject[record.source] = record.project || null;
    byProject[record.project || "<unknown-project>"] ||= bucket();
    byDay[datedBucketKey(record.timestamp)] ||= bucket();
    addRecord(byModel[model], record, cost);
    addRecord(bySession[record.source], record, cost);
    addRecord(byProject[record.project || "<unknown-project>"], record, cost);
    addRecord(byDay[datedBucketKey(record.timestamp)], record, cost);
    for (const name of new Set(record.tools || [])) {
      byTool[name] ||= toolBucket();
      byTool[name].calls++;
    }
    const priorTools = [...new Set(record.priorTools || [])];
    for (const name of priorTools) {
      byTool[name] ||= toolBucket();
      addRecord(byTool[name], attributedRecord(record, priorTools.length), attributedCost(cost, priorTools.length));
      byTool[name].followOnRequests++;
      // A cohort of one tool is not a split: the whole billed turn belongs to
      // it, which is the one case the cohort model can say with confidence
      // rather than by equal division. `attributedCost` is a no-op at
      // divisor 1, so this is the same dollars `addRecord` just added to `usd`.
      if (priorTools.length === 1 && cost.priced) {
        byTool[name].soloUsd += cost.usd;
        byTool[name].soloFollowOnRequests++;
      }
    }
  }
  const promptTokens = all.usage.input + all.usage.cacheCreate + all.usage.cacheRead;
  const sessions = Object.entries(bySession)
    .map(([id, value]) => ({
      id,
      project: sessionProject[id] ?? null,
      ...value,
      // Average context carried into a billed turn. Cost per turn says a
      // session is expensive; this says whether the prompt is why.
      avgPromptTokens: value.requests ? Math.round((value.usage.input + value.usage.cacheCreate + value.usage.cacheRead) / value.requests) : 0,
    }))
    .sort((a, b) => b.usd - a.usd || b.usage.total - a.usage.total)
    .slice(0, sessionLimit);
  const projects = Object.entries(byProject)
    .map(([id, value]) => ({ id, ...value }))
    .sort((a, b) => b.usd - a.usd || b.usage.total - a.usage.total)
    .slice(0, projectLimit);
  const tools = Object.entries(byTool)
    .map(([name, value]) => ({
      name,
      ...value,
      // Per-use economics, not per-turn: a tool ranked #1 by ubiquity can still
      // be cheap each time it runs. Null rather than a divide-by-zero reading
      // when a tool appears in a cohort with no counted call of its own, which
      // a windowed report can produce.
      usdPerCall: value.calls ? value.usd / value.calls : null,
      // How much of this tool's attributed cost survived from a cohort where
      // it was the only tool, versus an equal split with others. Null when the
      // tool has no priced cost to take a share of.
      soloShare: value.usd ? value.soloUsd / value.usd : null,
    }))
    .sort((a, b) => b.usd - a.usd || b.usage.total - a.usage.total || b.calls - a.calls)
    .slice(0, toolLimit);
  return {
    generatedAt: new Date().toISOString(),
    // The resolved window travels with the report so a tag snapshot records the
    // window it was taken over and `compare` can print both.
    scope: { sinceMs, untilMs, recordsRead: rawRecords.length, recordsAfterDateFilter: dated.length },
    total: all,
    byModel: Object.fromEntries(Object.entries(byModel).sort((a, b) => b[1].usd - a[1].usd || b[1].usage.total - a[1].usage.total)),
    byDay: Object.fromEntries(Object.entries(byDay).sort(([a], [b]) => a.localeCompare(b))),
    topProjects: projects,
    topSessions: sessions,
    topTools: tools,
    // Counts only. The deduplicated record list stays a function-local: it is
    // per-turn data, and `report --json` is the artifact people share.
    diagnostics: { duplicatesDropped: dedup.duplicatesDropped, missingIds: dedup.missingIds },
    insights: {
      cacheReadShare: promptTokens ? all.usage.cacheRead / promptTokens : null,
      outputCostShare: all.usd ? all.outputUsd / all.usd : null,
      // Where the dollars went, not where the tokens went: a cache read costs
      // 0.1x input and a 1-hour write 2x, so the two splits differ by up to 20x.
      costClassShares: all.usd
        ? {
          input: all.usdByClass.input / all.usd,
          cacheWrite: all.usdByClass.cacheWrite / all.usd,
          cacheRead: all.usdByClass.cacheRead / all.usd,
          output: all.usdByClass.output / all.usd,
        }
        : null,
      // Share of cache-write dollars bought at the 1-hour rate. The rest is the
      // 5-minute rate plus whatever the log left unclassified.
      cacheWrite1hShare: all.usdByClass.cacheWrite ? all.usdByClass.cacheWrite1h / all.usdByClass.cacheWrite : null,
      // What a turn costs, over the priced turns only. The mean alone hides the
      // shape: a handful of huge turns pulls it well above the turn most of the
      // window actually looks like, which is what p50 and p90 are for.
      perTurnUsd: turnDistribution(pricedTurns),
      unpricedTokens: all.unpricedTokens,
    },
  };
}

// Every threshold a recommendation is measured against, in one place: a rule
// nobody can locate the boundary of is a rule nobody can argue with.
const MODEL_CONCENTRATION_SHARE = 0.5;
const OUTPUT_COST_SHARE = 0.15;
const CACHE_READ_HEALTHY_SHARE = 0.8;
// A cache read is billed at a tenth of the input rate, so the same tokens read
// uncached would have cost ten times what they did; the saving is the other
// nine tenths of that counterfactual bill.
const CACHE_READ_SAVINGS_MULTIPLIER = 9;
// Below this on either side the ordering is real but the money is not, and a
// recommendation about a few cents is noise.
const CACHE_ECONOMICS_FLOOR_USD = 1;
const SESSION_OUTLIER_USD = 10;
const CONTEXT_BLOAT_TOKENS = 150_000;
const CONTEXT_BLOAT_USD = 5;
const CONTEXT_BLOAT_HIGH_SHARE = 0.2;
const MCP_FOLLOW_ON_USD = 10;
const MCP_FOLLOW_ON_HIGH_SHARE = 0.2;
const BASH_FILTER_USD = 25;
const ACCELERATION_PCT = 0.5;
const ACCELERATION_USD = 10;

/**
 * Re-price a model's own tokens at its cheaper sibling's rate. The counterfactual
 * holds the usage fixed — the same turns, the same token mix — which makes the
 * difference an upper bound on what a switch could save rather than a forecast.
 * Null whenever the comparison cannot be made honestly: no sibling, no local
 * rate for it, an aggregate with no token counts, or a difference that is not a
 * saving.
 */
function modelWhatIf(model, aggregate) {
  if (!aggregate?.usage) return null;
  const sibling = cheaperSiblingModel(model);
  const repriced = sibling ? priceUsage(aggregate.usage, sibling) : null;
  if (!repriced) return null;
  const savedUsd = (aggregate.usd || 0) - repriced.usd;
  return savedUsd > 0 ? { model: sibling, savedUsd } : null;
}

/**
 * The cache verdict in dollars rather than in token share. Tokens rank the two
 * classes wrongly: writes cost 1.25x or 2x the input rate and reads a tenth of
 * it, so a window can read overwhelmingly from cache and still be losing money
 * on it. Null when nothing is priced, or when both sides are too small to call.
 */
function cacheEconomics(report) {
  const byClass = report.total?.usdByClass;
  if (!byClass) return null;
  const writeUsd = byClass.cacheWrite || 0;
  const savedUsd = (byClass.cacheRead || 0) * CACHE_READ_SAVINGS_MULTIPLIER;
  if (writeUsd <= 0 && savedUsd <= 0) return null;
  if (writeUsd < savedUsd) return {
    kind: "cache",
    severity: "info",
    evidence: `Cache writes cost ${formatUsd(writeUsd)} and saved ≈ ${formatUsd(savedUsd)} against uncached reads, which would have been billed at the full input rate.`,
    action: "Caching is net positive here; prioritize model concentration and tool-output volume before changing TTL policy.",
  };
  if (writeUsd < CACHE_ECONOMICS_FLOOR_USD || savedUsd < CACHE_ECONOMICS_FLOOR_USD) return null;
  const oneHour = report.insights?.cacheWrite1hShare;
  const ttl = oneHour != null && oneHour >= 0.5 ? ` 1-hour writes are ${(oneHour * 100).toFixed(1)}% of that write cost, at twice the input rate.` : "";
  return {
    kind: "cache",
    severity: "medium",
    evidence: `Cache writes cost ${formatUsd(writeUsd)} against ≈ ${formatUsd(savedUsd)} saved on reads: this window pays more to fill the cache than its reads recover.${ttl}`,
    action: "Inspect session restarts, directory/worktree churn, and MCP catalog size; each one refills the cache before enough turns read it back.",
  };
}

/** The token-share reading, kept as the fallback for a window with no dollars. */
function cacheShare(report) {
  if (report.insights?.cacheReadShare == null) return null;
  const efficient = report.insights.cacheReadShare >= CACHE_READ_HEALTHY_SHARE;
  return {
    kind: "cache",
    severity: efficient ? "info" : "medium",
    evidence: `Cache reads are ${(report.insights.cacheReadShare * 100).toFixed(1)}% of prompt tokens.`,
    action: efficient
      ? "Caching is already net positive on tokens; prioritize model concentration and tool-output volume before changing TTL policy."
      : "Inspect directory/worktree changes, session restarts, and MCP catalog size before paying for a longer cache TTL.",
  };
}

/**
 * The one session whose per-turn context is the reason it is expensive.
 * `topSessions` is already ordered by cost, so the first match is the worst
 * offender — and one row is the point: repeating the same advice per session
 * buries which one to actually look at.
 */
function contextBloat(report) {
  const worst = (report.topSessions || []).find((session) => (session.avgPromptTokens || 0) >= CONTEXT_BLOAT_TOKENS && (session.usd || 0) >= CONTEXT_BLOAT_USD);
  if (!worst) return null;
  const share = report.total?.usd ? worst.usd / report.total.usd : 0;
  return {
    kind: "context-bloat",
    severity: share >= CONTEXT_BLOAT_HIGH_SHARE ? "high" : "medium",
    evidence: `Session ${worst.id} averaged ${Math.round(worst.avgPromptTokens / 1000)}K prompt tokens per turn across ${worst.requests || 0} turn(s) (≈${formatUsd(worst.usd)}).`,
    action: "Start fresh sessions at task boundaries, or compact earlier: a long transcript re-bills the whole context on every turn as cache reads.",
  };
}

/**
 * Bash follow-on cost, pointed at this tool's own lever. Measured filter savings
 * are quoted when the local ledger has any; they are what the filter actually
 * removed, not a projection of what it would remove next.
 */
function bashOutputFilter(report, filterStats) {
  const bash = report.topTools?.find((tool) => tool.name === "Bash");
  if (!(bash?.usd >= BASH_FILTER_USD)) return null;
  const measured = filterStats?.savedChars > 0
    ? ` The local output filter has already removed ~${tokenFormat.format(filterStats.estimatedTokensSaved || 0)} input tokens across ${filterStats.events || 0} filtered result(s).`
    : "";
  return {
    kind: "bash-output-filter",
    severity: "medium",
    evidence: `Bash carries ${formatUsd(bash.usd)} in equally apportioned follow-on request cost across ${bash.followOnRequests || 0} turn(s) — correlation for prioritization, not proof that the output caused the cost.${measured}`,
    action: "Enable the local PostToolUse output filter with `agent-finops hook-config`, then measure what it removes with `agent-finops filter-report`.",
  };
}

/**
 * One side of a trend. `analyzeTrend` wraps each window as `{start, end,
 * report}`; a bare report is accepted too, so a caller that assembled the
 * comparison itself is not forced into that shape.
 */
function trendWindow(side) {
  return side?.report || side || null;
}

function spendAcceleration(trend) {
  const current = trendWindow(trend?.current);
  const previous = trendWindow(trend?.previous);
  if (!current || trend.deltaPct == null) return null;
  if (trend.deltaPct < ACCELERATION_PCT || (current.total?.usd || 0) < ACCELERATION_USD) return null;
  const driver = trend.drivers?.byModel?.[0];
  const named = driver ? ` The largest model-level change is ${driver.model} at ${formatUsd(driver.deltaUsd)}.` : "";
  return {
    kind: "spend-acceleration",
    severity: "medium",
    evidence: `Estimated spend rose ${(trend.deltaPct * 100).toFixed(1)}% against the previous ${trend.days}-day window, ${formatUsd(previous?.total?.usd || 0)} → ${formatUsd(current.total.usd)}.${named}`,
    action: "Check whether the workload itself grew before changing configuration; compare tagged, matched task windows before attributing the change to anything.",
  };
}

/**
 * Turn a report into ranked next experiments. `extras` is optional context a
 * report cannot hold on its own — the filter ledger and a trend over the same
 * records — and every rule that reads it degrades to silence when it is absent,
 * so a caller that has neither still gets the full set of report-only findings.
 */
export function hotspotAnalysis(report, extras = {}) {
  const modelRows = Object.entries(report.byModel);
  const topModel = modelRows[0];
  const recommendations = [];
  if (topModel && report.total.usd > 0) {
    const share = topModel[1].usd / report.total.usd;
    if (share >= MODEL_CONCENTRATION_SHARE) {
      const whatIf = modelWhatIf(topModel[0], topModel[1]);
      const counterfactual = whatIf
        ? ` Re-pricing the same tokens at ${whatIf.model} rates ≈ ${formatUsd(whatIf.savedUsd)} less over this window — an upper bound, not a promise: a smaller model may need more turns for the same work.`
        : "";
      recommendations.push({
        kind: "model-concentration",
        severity: "high",
        evidence: `${topModel[0]} is ${(share * 100).toFixed(1)}% of estimated spend.${counterfactual}`,
        action: "Run a tagged, comparable task set with a lower-cost model before changing the global default.",
      });
    }
  }
  if (report.insights.outputCostShare != null && report.insights.outputCostShare >= OUTPUT_COST_SHARE) recommendations.push({
    kind: "output-cost",
    severity: "medium",
    evidence: `Output tokens are ${(report.insights.outputCostShare * 100).toFixed(1)}% of estimated spend.`,
    action: "Constrain verbose plans and repeated explanations; preserve detailed output only for failing diagnostics.",
  });
  const cache = cacheEconomics(report) || cacheShare(report);
  if (cache) recommendations.push(cache);
  if (report.topSessions[0]?.usd >= SESSION_OUTLIER_USD) recommendations.push({
    kind: "session-outlier",
    severity: "medium",
    evidence: `The top anonymous session cost ${formatUsd(report.topSessions[0].usd)}.`,
    action: "Use session-level tags to compare its workflow against cheaper successful sessions; do not inspect transcript content by default.",
  });
  const bloat = contextBloat(report);
  if (bloat) recommendations.push(bloat);
  const topMcp = report.topTools?.find((tool) => tool.name.startsWith("mcp__"));
  if (topMcp?.usd >= MCP_FOLLOW_ON_USD) recommendations.push({
    kind: "mcp-follow-on-cost",
    severity: topMcp.usd / report.total.usd >= MCP_FOLLOW_ON_HIGH_SHARE ? "high" : "medium",
    evidence: `${topMcp.name} has ${formatUsd(topMcp.usd)} in equally apportioned follow-on request cost across ${topMcp.followOnRequests} turn(s).`,
    action: "Inspect this MCP's schema and result size, then compare a tagged workflow with fewer calls or a narrower response.",
  });
  const bash = bashOutputFilter(report, extras.filterStats);
  if (bash) recommendations.push(bash);
  const acceleration = spendAcceleration(extras.trend);
  if (acceleration) recommendations.push(acceleration);
  return { generatedAt: new Date().toISOString(), recommendations };
}

export function compareSnapshots(leftName, left, rightName, right) {
  const delta = right.total.usd - left.total.usd;
  const percent = left.total.usd ? delta / left.total.usd : null;
  const allModels = new Set([...Object.keys(left.byModel), ...Object.keys(right.byModel)]);
  const byModel = [...allModels].map((model) => ({
    model,
    leftUsd: left.byModel[model]?.usd || 0,
    rightUsd: right.byModel[model]?.usd || 0,
  })).map((row) => ({ ...row, deltaUsd: row.rightUsd - row.leftUsd }))
    .sort((a, b) => Math.abs(b.deltaUsd) - Math.abs(a.deltaUsd));
  // Two snapshots priced by different revisions of the rate table are not
  // comparable: part of the delta is the correction, not a change in spending.
  const pricingMismatch = (left.pricing ?? null) !== (right.pricing ?? null);
  return { leftName, rightName, left, right, deltaUsd: delta, deltaPct: percent, byModel, pricingMismatch };
}

function formatUsd(value) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
}

export function humanHotspots(analysis) {
  if (!analysis.recommendations.length) return "No cost hotspots found in this period.";
  return ["agent-finops hotspots", ...analysis.recommendations.flatMap((item) => [
    "",
    `[${item.severity}] ${item.kind}`,
    `  Evidence: ${item.evidence}`,
    `  Next: ${item.action}`,
  ])].join("\n");
}

/**
 * The window a snapshot covers, as it was resolved when the snapshot was taken.
 * A comparison is only meaningful across matched windows, and until `--from`/
 * `--to` existed there was no way to state — let alone match — one exactly.
 */
function windowLine(name, snapshot) {
  const scope = snapshot?.scope || {};
  const from = Number.isFinite(scope.sinceMs) ? new Date(scope.sinceMs).toISOString() : "start of history";
  const to = Number.isFinite(scope.untilMs) ? new Date(scope.untilMs).toISOString() : "end of history";
  return `  ${name.padEnd(24)} ${from} → ${to}`;
}

export function humanComparison(comparison) {
  const percent = comparison.deltaPct == null ? "n/a" : `${(comparison.deltaPct * 100).toFixed(1)}%`;
  const lines = [
    `agent-finops compare: ${comparison.leftName} → ${comparison.rightName}`,
    `Estimated cost: ${formatUsd(comparison.left.total.usd)} → ${formatUsd(comparison.right.total.usd)} (${formatUsd(comparison.deltaUsd)}, ${percent})`,
    "",
    "Windows (start inclusive, end exclusive):",
    windowLine(comparison.leftName, comparison.left),
    windowLine(comparison.rightName, comparison.right),
    "",
    "Largest model deltas:",
  ];
  for (const row of comparison.byModel.slice(0, 8)) lines.push(`  ${row.model.padEnd(24)} ${formatUsd(row.deltaUsd)}`);
  lines.push("", "Comparison is descriptive. Use matching task sets and the same time window before attributing a cost difference to a change.");
  if (comparison.pricingMismatch) lines.push("Warning: these snapshots were taken under different rate-table revisions. Part of this delta is a pricing correction, not a change in spending. Re-tag both windows to compare like with like.");
  return lines.join("\n");
}

export function humanSessions(sessions) {
  if (!sessions.length) return "No sessions found in this period.";
  const number = tokenFormat;
  const lines = ["Sessions (anonymous local IDs):"];
  for (const session of sessions) lines.push(`  ${session.id}  ${formatUsd(session.usd)}  ${number.format(session.usage.total)} tokens  ${session.requests} turns`);
  lines.push("", "Use `agent-finops session ID` for one session or `compare-sessions A B` for a direct comparison.");
  return lines.join("\n");
}

// $/call at 3 decimals under a dollar and 2 above: below a dollar the third
// decimal is the difference between two tools, and above one it is noise.
function formatUsdPerCall(usd) {
  if (usd == null) return "n/a";
  return `$${usd.toFixed(usd < 1 ? 3 : 2)}/call`;
}

function formatSoloShare(share) {
  return share == null ? "solo n/a" : `solo ${Math.round(share * 100)}%`;
}

export function humanTools(tools, { onlyMcp = false } = {}) {
  const rows = onlyMcp ? tools.filter((tool) => tool.name.startsWith("mcp__")) : tools;
  if (!rows.length) return onlyMcp ? "No MCP tool calls found in this period." : "No tool calls found in this period.";
  const number = tokenFormat;
  const label = onlyMcp ? "MCP" : "Tool/MCP";
  const lines = [`${label} follow-on attribution (local estimate):`];
  for (const tool of rows) lines.push(`  ${tool.name.padEnd(34)} ${formatUsd(tool.usd).padStart(10)}  ${number.format(tool.usage.total)} tokens  ${tool.calls} call(s)  ${tool.followOnRequests} follow-on turn(s)  ${formatUsdPerCall(tool.usdPerCall)}  ${formatSoloShare(tool.soloShare)}`);
  lines.push(
    "",
    "Each billed assistant turn immediately after tool use is split equally among tools called in the prior assistant message. This is correlation for prioritization, not an invoice line item or proof of causation.",
    "Solo % is the share of a tool's attributed cost from turns where it was the only tool in the cohort — higher means the correlation is less diluted.",
  );
  return lines.join("\n");
}

// The four classes a dollar can belong to, with the name each one is printed
// under. `cacheWrite` is the total; the per-TTL rows break it down and are
// reported as a share of it, never as a fifth class.
const COST_CLASS_NAMES = [["input", "input"], ["cacheWrite", "cache-write"], ["cacheRead", "cache-read"], ["output", "output"]];

/**
 * Where the dollars went, largest first. Tokens and dollars rank differently —
 * a cache read costs 0.1x input and a 1-hour write 2x — so the class that
 * dominates the token line is often not the one paying for the window. Nothing
 * priced means no line at all rather than a row of zeroes.
 */
function costClassLine(report) {
  const byClass = report.total.usdByClass;
  if (!byClass || !report.total.usd) return null;
  const parts = COST_CLASS_NAMES
    .map(([key, name]) => ({ name, usd: byClass[key] || 0 }))
    .sort((a, b) => b.usd - a.usd)
    .map((item) => `${item.name} ${formatUsd(item.usd)} (${Math.round((item.usd / report.total.usd) * 100)}%)`);
  const oneHour = report.insights?.cacheWrite1hShare;
  const ttl = oneHour == null ? "" : ` (1h writes ${Math.round(oneHour * 100)}% of cache-write cost)`;
  return `Cost by class: ${parts.join(" · ")}${ttl}`;
}

export function humanReport(report) {
  const number = tokenFormat;
  const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
  const percent = (value) => (value == null ? "n/a" : `${(value * 100).toFixed(1)}%`);
  const u = report.total.usage;
  const byClass = costClassLine(report);
  const lines = [
    "agent-finops — local-only estimate",
    `Scope: ${report.scope.recordsAfterDateFilter.toLocaleString()} usage records before keep-last deduplication`,
    `Estimated cost: ${usd.format(report.total.usd)}${report.total.unpricedTokens ? " (partial; unpriced models present)" : ""}`,
    `Tokens: ${number.format(u.total)}  input ${number.format(u.input)}  cache-write ${number.format(u.cacheCreate)}  cache-read ${number.format(u.cacheRead)}  output ${number.format(u.output)}`,
    ...(byClass ? [byClass] : []),
    `Cache-read share: ${percent(report.insights.cacheReadShare)} · output-cost share: ${percent(report.insights.outputCostShare)}`,
    "",
    "By model:",
  ];
  for (const [model, value] of Object.entries(report.byModel)) {
    lines.push(`  ${model.padEnd(24)} ${usd.format(value.usd).padStart(10)}  ${number.format(value.usage.total).padStart(12)} tokens  ${value.requests} turns`);
  }
  if (report.topSessions.length) {
    lines.push("", "Top anonymous sessions:");
    for (const value of report.topSessions) lines.push(`  ${value.id}  ${usd.format(value.usd)}  ${number.format(value.usage.total)} tokens`);
  }
  if (report.topTools?.length) {
    lines.push("", "Top tool/MCP follow-on estimates:");
    for (const tool of report.topTools.slice(0, 5)) lines.push(`  ${tool.name.padEnd(34)} ${usd.format(tool.usd)}  ${number.format(tool.usage.total)} tokens  ${tool.followOnRequests} follow-on turns`);
    lines.push("  Attribution is equally split across tools in the prior tool-call message; use `agent-finops tools` for details.");
  }
  lines.push("", "Diagnostics:");
  if (report.diagnostics.duplicatesDropped) lines.push(`  ${report.diagnostics.duplicatesDropped} streaming duplicate(s) collapsed with keep-last semantics.`);
  if (report.diagnostics.missingIds) lines.push(`  ${report.diagnostics.missingIds} record(s) lacked a full dedup key and were conservatively retained.`);
  if (report.total.unpricedTokens) lines.push(`  ${number.format(report.total.unpricedTokens)} token(s) belong to unpriced models; no dollar figure was invented.`);
  if (!report.diagnostics.duplicatesDropped && !report.diagnostics.missingIds && !report.total.unpricedTokens) lines.push("  No accounting warnings.");
  lines.push("", "No network · no subprocesses · local metadata only · content redacted before JSON decoding");
  return lines.join("\n");
}
