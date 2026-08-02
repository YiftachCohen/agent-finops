import { displayProject } from "./labels.mjs";
import { CACHE_READ_MULTIPLIER, CACHE_WRITE_1H_MULTIPLIER, CACHE_WRITE_5M_MULTIPLIER, canonicalModelId, cheaperSiblingModel, costFor, priceUsage } from "./rates.mjs";

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

// A record whose timestamp cannot be parsed still counts, but it cannot be
// placed on a calendar day: it is bucketed here and excluded from every reading
// that is per-day, rather than being dropped or dated by guesswork.
const UNDATED_BUCKET = "<unknown-date>";

function datedBucketKey(timestamp) {
  const time = Date.parse(timestamp || "");
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : UNDATED_BUCKET;
}

// A month at the current pace. Thirty days, not a calendar month, so the figure
// is a fixed multiple of a daily rate rather than a number that changes meaning
// in February.
const PROJECTION_DAYS = 30;

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

/**
 * What this window costs per day, and how the worst day compares with the usual
 * one. A total with no time context is unreadable: $5,000 is a rounding error
 * over a year and an emergency over a week.
 *
 * `days` counts the distinct UTC day buckets that hold records, not the calendar
 * span of the window. A 30-day window worked on 12 days is a 12-day rate:
 * dividing by the span would average in days nobody was running the agent and
 * understate the pace of the days that were worked, which is the pace a
 * projection is made of. The projection says so — it is what 30 days like these
 * would cost on this same workload, never a forecast of the next 30.
 *
 * `usdPerDay` spreads the window's whole estimate — including any record too
 * undated to place on a day — over the days it could place, so the rate and the
 * headline cost stay the same money. Null when nothing is dated at all.
 */
function runRateOf(byDay, totalUsd) {
  const dated = Object.entries(byDay).filter(([day]) => day !== UNDATED_BUCKET).sort(([a], [b]) => a.localeCompare(b));
  if (!dated.length) return null;
  const usdPerDay = totalUsd / dated.length;
  const median = percentileOf(dated.map(([, value]) => value.usd).sort((a, b) => a - b), 0.5);
  const peak = dated.reduce((worst, entry) => (entry[1].usd > worst[1].usd ? entry : worst));
  return {
    days: dated.length,
    firstDay: dated[0][0],
    lastDay: dated[dated.length - 1][0],
    usdPerDay,
    projectedMonthlyUsd: usdPerDay * PROJECTION_DAYS,
    // The most expensive day, against the day this window usually looks like.
    // A ratio is how an anomalous burn is spotted; the median is the baseline
    // because one runaway day would drag a mean up toward itself and hide.
    // Null ratio when the median day cost nothing — a multiple of zero is not a
    // reading — rather than an infinity.
    peakDay: { day: peak[0], usd: peak[1].usd, ratioToMedian: median > 0 ? peak[1].usd / median : null },
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
      // Spend per active day, the month that pace comes to, and the peak day
      // against the median one. Null when no record in the window can be dated.
      runRate: runRateOf(byDay, all.usd),
      unpricedTokens: all.unpricedTokens,
    },
  };
}

// Every threshold a recommendation is measured against, in one place: a rule
// nobody can locate the boundary of is a rule nobody can argue with.
const MODEL_CONCENTRATION_SHARE = 0.5;
const OUTPUT_COST_SHARE = 0.15;
const CACHE_READ_HEALTHY_SHARE = 0.8;
// The TTL question is only worth raising once the 1-hour premium is real money
// and is most of what the window paid to fill its cache. Below either bound the
// split is an ordering, not a lever.
const CACHE_TTL_1H_USD = 10;
const CACHE_TTL_1H_SHARE = 0.5;
// One number for "cache writes are a large share of this bill": it raises the
// TTL finding from a tradeoff to understand to one worth acting on, and it is
// what makes the fallback cache reading worth printing at all.
const CACHE_WRITE_HEAVY_SHARE = 0.35;
const SESSION_OUTLIER_USD = 10;
const CONTEXT_BLOAT_TOKENS = 150_000;
// Deliberately the same number as the trigger: the context size that makes a
// session a finding is also the ceiling its counterfactual is measured against,
// so the rule cannot claim a saving for shrinking a context it never flagged.
const CONTEXT_TARGET_TOKENS = CONTEXT_BLOAT_TOKENS;
const CONTEXT_BLOAT_USD = 5;
const CONTEXT_BLOAT_HIGH_SHARE = 0.2;
const MCP_FOLLOW_ON_USD = 10;
const MCP_FOLLOW_ON_HIGH_SHARE = 0.2;
const BASH_FILTER_USD = 25;
const ACCELERATION_PCT = 0.5;
const ACCELERATION_USD = 10;

// What the same cache-write tokens would have cost at the 5-minute rate instead
// of the 1-hour one, as a share of what they did cost: 1 - 1.25/2 = 0.375.
const CACHE_TTL_SAVINGS_RATIO = 1 - CACHE_WRITE_5M_MULTIPLIER / CACHE_WRITE_1H_MULTIPLIER;
// The 1-hour write's premium over the 5-minute one, stated the way the tradeoff
// is felt: 2 / 1.25 = 1.6, so it is 60% more per write.
const CACHE_TTL_PREMIUM_PCT = Math.round((CACHE_WRITE_1H_MULTIPLIER / CACHE_WRITE_5M_MULTIPLIER - 1) * 100);

// Ranking order for a tie on savings. Two findings worth the same estimated
// dollars are separated by how confidently the rule fired, and only then by the
// order the rules run in.
const SEVERITY_RANK = { __proto__: null, high: 0, medium: 1, info: 2 };

/**
 * Rank recommendations by what acting on them is estimated to be worth: most
 * dollars first, unquantified findings last, ties broken by severity and then
 * by the order the rules produced them. `null` sorts last rather than as zero —
 * "no defensible counterfactual" is not "worth nothing".
 */
function rankRecommendations(recommendations) {
  return recommendations
    .map((item, order) => ({ item, order }))
    .sort((a, b) => {
      const left = a.item.estimatedSavingsUsd ?? null;
      const right = b.item.estimatedSavingsUsd ?? null;
      if ((left === null) !== (right === null)) return left === null ? 1 : -1;
      if (left !== null && right !== null && left !== right) return right - left;
      return (SEVERITY_RANK[a.item.severity] ?? 99) - (SEVERITY_RANK[b.item.severity] ?? 99) || a.order - b.order;
    })
    .map((entry) => entry.item);
}

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

/** Cache writes as a share of the window's estimated spend, or null unpriced. */
function cacheWriteShare(report) {
  const byClass = report.total?.usdByClass;
  const totalUsd = report.total?.usd || 0;
  if (!byClass || !totalUsd) return null;
  return (byClass.cacheWrite || 0) / totalUsd;
}

/**
 * The one cache question whose answer actually varies. Comparing write cost with
 * what reads would have cost uncached does not: a read is billed at a tenth of
 * the input rate and an agent re-reads its context every turn, so that
 * counterfactual is enormous and favourable in every window, which makes it
 * decoration rather than a finding.
 *
 * The TTL split is the real decision surface. A 1-hour write costs 2x the input
 * rate and a 5-minute write 1.25x, so the same tokens carry a 60% premium — but
 * a 5-minute entry that expires between turns is re-written whole, and one
 * re-write costs more than the premium saved. This states both sides and the
 * dollars on the table; it does not tell anyone which way to go.
 */
function cacheTtl(report) {
  const byClass = report.total?.usdByClass;
  if (!byClass) return null;
  const writeUsd = byClass.cacheWrite || 0;
  const oneHourUsd = byClass.cacheWrite1h || 0;
  if (oneHourUsd < CACHE_TTL_1H_USD || writeUsd <= 0) return null;
  const oneHourShare = oneHourUsd / writeUsd;
  if (oneHourShare < CACHE_TTL_1H_SHARE) return null;
  const spendShare = cacheWriteShare(report);
  const savedUsd = oneHourUsd * CACHE_TTL_SAVINGS_RATIO;
  const shareOfSpend = spendShare == null ? "" : `${(spendShare * 100).toFixed(1)}% of estimated spend (${formatUsd(writeUsd)})`;
  return {
    kind: "cache-ttl",
    severity: spendShare != null && spendShare > CACHE_WRITE_HEAVY_SHARE ? "medium" : "info",
    estimatedSavingsUsd: savedUsd,
    evidence: `Cache writes are ${shareOfSpend || formatUsd(writeUsd)}, of which ${(oneHourShare * 100).toFixed(1)}% (${formatUsd(oneHourUsd)}) was bought at the 1-hour rate (2x input) rather than the 5-minute rate (1.25x). The same tokens written at the 5-minute rate would be ${formatUsd(savedUsd)} less — an upper bound that assumes every one of those entries would still have been read before it expired.`,
    action: `This is a tradeoff, not a defect: a 1-hour TTL costs ${CACHE_TTL_PREMIUM_PCT}% more per write, but a 5-minute entry that expires between turns is re-written in full, and one re-write costs more than the premium it saved. The lever is session cadence — long gaps between turns favour the 1-hour write, continuous work favours the 5-minute one — so measure a tagged window of each rather than flipping a flag.`,
  };
}

/**
 * The token-share reading, kept for the windows the TTL rule cannot speak to: no
 * per-class dollars at all, or a cache bill dominated by 5-minute writes. It is
 * only worth printing when cache writes are a large share of the spend, or when
 * there are no dollars to weigh them against and the token share is all there is.
 */
function cacheEfficiency(report) {
  if (report.insights?.cacheReadShare == null) return null;
  const spendShare = cacheWriteShare(report);
  if (spendShare != null && spendShare < CACHE_WRITE_HEAVY_SHARE) return null;
  const efficient = report.insights.cacheReadShare >= CACHE_READ_HEALTHY_SHARE;
  return {
    kind: "cache-efficiency",
    severity: efficient ? "info" : "medium",
    // No savings figure: a read share is not a counterfactual, and the honest
    // upper bound on "read from cache more" is a number this rule cannot derive.
    estimatedSavingsUsd: null,
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
function bloatedSession(report) {
  return (report.topSessions || []).find((session) => (session.avgPromptTokens || 0) >= CONTEXT_BLOAT_TOKENS && (session.usd || 0) >= CONTEXT_BLOAT_USD) || null;
}

/**
 * What capping this session's average prompt at `CONTEXT_TARGET_TOKENS` would
 * have saved. Only the cache-read line scales: it is the context re-billed on
 * every turn, so a prompt held to a fraction of its size re-bills that same
 * fraction. Null on a bucket with no per-class dollars — an older tag snapshot —
 * because guessing which part of its estimate was cache reads would invent the
 * number the finding is ranked by.
 */
function contextBloatSavings(session) {
  const cacheReadUsd = session.usdByClass?.cacheRead;
  const average = session.avgPromptTokens || 0;
  if (cacheReadUsd == null || average <= 0) return null;
  return Math.max(0, cacheReadUsd * (1 - CONTEXT_TARGET_TOKENS / average));
}

function contextBloat(report, worst) {
  if (!worst) return null;
  const share = report.total?.usd ? worst.usd / report.total.usd : 0;
  const savedUsd = contextBloatSavings(worst);
  const counterfactual = savedUsd == null
    ? ""
    : ` Holding the average prompt to ${Math.round(CONTEXT_TARGET_TOKENS / 1000)}K would re-bill its cache reads in proportion, ≈${formatUsd(savedUsd)} less — an upper bound that assumes the same work fits in the smaller context.`;
  return {
    kind: "context-bloat",
    severity: share >= CONTEXT_BLOAT_HIGH_SHARE ? "high" : "medium",
    estimatedSavingsUsd: savedUsd,
    evidence: `Session ${worst.id} averaged ${Math.round(worst.avgPromptTokens / 1000)}K prompt tokens per turn across ${worst.requests || 0} turn(s) (≈${formatUsd(worst.usd)}).${counterfactual}`,
    action: "Start fresh sessions at task boundaries, or compact earlier: a long transcript re-bills the whole context on every turn as cache reads.",
  };
}

/** The model that paid for most of this window; `byModel` is sorted by cost. */
function dominantModel(report) {
  return Object.keys(report.byModel || {})[0] || null;
}

/**
 * What the tokens the local filter removed would have cost. They would have
 * entered the context as a cache write, so they are priced as one at the
 * dominant model's rate — through `priceUsage`, so the TTL multipliers are the
 * ones the real estimate uses, and at the 5-minute rate because unclassified
 * write tokens are always charged at the conservative floor. Null when the
 * ledger has removed nothing, or when the dominant model has no local rate.
 */
function filterSavings(report, filterStats) {
  if (!(filterStats?.savedChars > 0)) return null;
  const tokens = filterStats.estimatedTokensSaved || 0;
  if (tokens <= 0) return null;
  const model = dominantModel(report);
  const priced = model ? priceUsage({ cacheCreate: tokens }, model) : null;
  return priced ? priced.usd : null;
}

/**
 * Bash follow-on cost, pointed at this tool's own lever. Measured filter savings
 * are quoted when the local ledger has any; they are what the filter actually
 * removed, not a projection of what it would remove next. With no ledger the
 * finding still fires, unquantified: the cohort cost is the evidence, and the
 * saving is unknown rather than zero.
 */
function bashOutputFilter(report, filterStats) {
  const bash = report.topTools?.find((tool) => tool.name === "Bash");
  if (!(bash?.usd >= BASH_FILTER_USD)) return null;
  const savedUsd = filterSavings(report, filterStats);
  const priced = savedUsd == null ? "" : ` At ${dominantModel(report)} cache-write rates that is ≈${formatUsd(savedUsd)} of context never bought.`;
  const measured = filterStats?.savedChars > 0
    ? ` The local output filter has already removed ~${tokenFormat.format(filterStats.estimatedTokensSaved || 0)} input tokens across ${filterStats.events || 0} filtered result(s).${priced}`
    : "";
  return {
    kind: "bash-output-filter",
    severity: "medium",
    estimatedSavingsUsd: savedUsd,
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
    // A rise is a description, not a defect: the workload may simply have grown.
    // There is no counterfactual to price, so no saving is claimed.
    estimatedSavingsUsd: null,
    evidence: `Estimated spend rose ${(trend.deltaPct * 100).toFixed(1)}% against the previous ${trend.days}-day window, ${formatUsd(previous?.total?.usd || 0)} → ${formatUsd(current.total.usd)}.${named}`,
    action: "Check whether the workload itself grew before changing configuration; compare tagged, matched task windows before attributing the change to anything.",
  };
}

/**
 * Turn a report into ranked next experiments. `extras` is optional context a
 * report cannot hold on its own — the filter ledger and a trend over the same
 * records — and every rule that reads it degrades to silence when it is absent,
 * so a caller that has neither still gets the full set of report-only findings.
 *
 * Every finding carries `estimatedSavingsUsd`: the honest upper bound of acting
 * on it, or null where no counterfactual can be defended. The returned list is
 * ranked by it, because the question a FinOps tool exists to answer is which of
 * these is worth doing first. The figures are ceilings on the same workload, not
 * forecasts, and never a claim about a bill.
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
        estimatedSavingsUsd: whatIf ? whatIf.savedUsd : null,
        evidence: `${topModel[0]} is ${(share * 100).toFixed(1)}% of estimated spend.${counterfactual}`,
        action: "Run a tagged, comparable task set with a lower-cost model before changing the global default.",
      });
    }
  }
  if (report.insights.outputCostShare != null && report.insights.outputCostShare >= OUTPUT_COST_SHARE) recommendations.push({
    kind: "output-cost",
    severity: "medium",
    // Shorter output is a different answer, not the same one for less; there is
    // no fixed workload to re-price, so no saving is claimed.
    estimatedSavingsUsd: null,
    evidence: `Output tokens are ${(report.insights.outputCostShare * 100).toFixed(1)}% of estimated spend.`,
    action: "Constrain verbose plans and repeated explanations; preserve detailed output only for failing diagnostics.",
  });
  const cache = cacheTtl(report) || cacheEfficiency(report);
  if (cache) recommendations.push(cache);
  // The two session rules are one diagnosis each, so they never name the same
  // row: context-bloat is the more specific reading and carries a saving, and a
  // session it already claims is not also reported as a bare outlier. What is
  // left for session-outlier is the genuinely different case — expensive because
  // of how many turns it ran, not how much context each one hauled. Sessions are
  // ordered by cost and context-bloat takes the first qualifying row, so a top
  // session it declined is one whose per-turn context is under the threshold.
  const bloated = bloatedSession(report);
  const topSession = report.topSessions?.[0];
  if (topSession?.usd >= SESSION_OUTLIER_USD && topSession.id !== bloated?.id) recommendations.push({
    kind: "session-outlier",
    severity: "medium",
    // "Run fewer turns" is not a counterfactual anyone can price: the turns are
    // the work. The finding says where to look, not what it is worth.
    estimatedSavingsUsd: null,
    evidence: `The top anonymous session cost ${formatUsd(topSession.usd)} across ${topSession.requests || 0} turn(s), averaging ${tokenFormat.format(topSession.avgPromptTokens || 0)} prompt tokens per turn — under the ${Math.round(CONTEXT_BLOAT_TOKENS / 1000)}K context-bloat threshold, so this session is expensive for how many turns it ran rather than how heavy each one was.`,
    action: "Use session-level tags to compare its turn count and workflow against cheaper successful sessions; do not inspect transcript content by default.",
  });
  const bloat = contextBloat(report, bloated);
  if (bloat) recommendations.push(bloat);
  const topMcp = report.topTools?.find((tool) => tool.name.startsWith("mcp__"));
  if (topMcp?.usd >= MCP_FOLLOW_ON_USD) recommendations.push({
    kind: "mcp-follow-on-cost",
    severity: topMcp.usd / report.total.usd >= MCP_FOLLOW_ON_HIGH_SHARE ? "high" : "medium",
    // The cohort is correlation, so its dollars are not a saving waiting to be
    // taken: pricing them as one would present attribution as causation.
    estimatedSavingsUsd: null,
    evidence: `${topMcp.name} has ${formatUsd(topMcp.usd)} in equally apportioned follow-on request cost across ${topMcp.followOnRequests} turn(s).`,
    action: "Inspect this MCP's schema and result size, then compare a tagged workflow with fewer calls or a narrower response.",
  });
  const bash = bashOutputFilter(report, extras.filterStats);
  if (bash) recommendations.push(bash);
  const acceleration = spendAcceleration(extras.trend);
  if (acceleration) recommendations.push(acceleration);
  const ranked = rankRecommendations(recommendations);
  return {
    generatedAt: new Date().toISOString(),
    recommendations: ranked,
    // The headline a caller can lead with. Sums only what was quantified, so it
    // is a floor on the ranked list's ceiling, never a total of the window.
    totalEstimatedSavingsUsd: ranked.reduce((sum, item) => sum + (item.estimatedSavingsUsd || 0), 0),
  };
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

const usdWhole = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

// A projected pace, stated at the precision it can support: whole dollars once
// it is real money, cents below that. Printing cents on an extrapolation would
// claim an accuracy the extrapolation does not have.
function formatPaceUsd(value) {
  return value >= 100 ? usdWhole.format(value) : formatUsd(value);
}

// Three decimals under a dollar, two above: below a dollar the third decimal is
// the difference between two readings, and above one it is noise. The same
// split `$/call` uses, so a turn and a call are read on one scale.
function formatFineUsd(value) {
  return `$${value.toFixed(value < 1 ? 3 : 2)}`;
}

/**
 * A token count as context rather than as an accounting figure: 331K, not
 * 331,204. The same thresholds the dashboard uses, so one session reads the
 * same on both surfaces.
 */
function tokenLabel(value) {
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e4) return `${Math.round(value / 1e3)}K`;
  return tokenFormat.format(Math.round(value));
}

export function humanHotspots(analysis) {
  if (!analysis.recommendations.length) return "No cost hotspots found in this period.";
  const quantified = analysis.recommendations.filter((item) => item.estimatedSavingsUsd != null);
  const total = analysis.totalEstimatedSavingsUsd ?? quantified.reduce((sum, item) => sum + item.estimatedSavingsUsd, 0);
  const lines = ["agent-finops hotspots"];
  // The list is ranked whether or not anything carries a figure, but saying so
  // is only informative when there is a figure to rank by.
  if (quantified.length) lines.push(`Ranked by estimated upper-bound savings · ${formatUsd(total)} total across ${quantified.length} quantified finding${quantified.length === 1 ? "" : "s"}`);
  for (const item of analysis.recommendations) {
    lines.push(
      "",
      `[${item.severity}] ${item.kind}${item.estimatedSavingsUsd == null ? "" : ` · up to ${formatUsd(item.estimatedSavingsUsd)}`}`,
      `  Evidence: ${item.evidence}`,
      `  Next: ${item.action}`,
    );
  }
  lines.push(
    "",
    "Every figure here is a local estimate from list prices, not a bill. Savings are upper bounds on this same workload — what the window would have cost with the change already in place — not a forecast of what the next one will cost.",
  );
  return lines.join("\n");
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

/**
 * The project a session ran under, named by the local label when it has one. An
 * unlabelled id is shortened: the row is about the session, and the full
 * fingerprint the `project` command takes is what `projects` prints. A record
 * with no project id leaves the session unattributed rather than inventing one.
 */
function sessionProjectColumn(session, labels) {
  if (!session.project) return "unattributed";
  return `project ${labels[session.project] || session.project.slice(0, 6)}`;
}

/**
 * One session row. A bare fingerprint and a dollar figure are not something
 * anyone can act on; the project it ran under and the context it hauls into
 * every turn are what turn it into a diagnosis, and both are already on the
 * record.
 */
function sessionLine(session, labels) {
  return [
    `  ${session.id}`,
    formatUsd(session.usd).padStart(10),
    `${tokenFormat.format(session.usage.total).padStart(14)} tokens`,
    `${session.requests} turns`,
    `${tokenLabel(session.avgPromptTokens || 0)} ctx/turn`,
    sessionProjectColumn(session, labels),
  ].join("  ");
}

export function humanSessions(sessions, labels = {}) {
  if (!sessions.length) return "No sessions found in this period.";
  const lines = ["Sessions (anonymous local IDs):"];
  for (const session of sessions) lines.push(sessionLine(session, labels));
  lines.push("", "Use `agent-finops session ID` for one session or `compare-sessions A B` for a direct comparison.");
  return lines.join("\n");
}

function formatUsdPerCall(usd) {
  if (usd == null) return "n/a";
  return `${formatFineUsd(usd)}/call`;
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

/**
 * The one line that states a token share and a dollar share together. Read on
 * its own, "cache-read share 96.7%" sits directly under "cache-read $2,710.50
 * (53%)" and the two look like a contradiction — which is the exact confusion
 * this tool exists to remove. Both denominators are named in the sentence, the
 * cost share is the same figure the cost-by-class line above already printed, and
 * the rate that explains the whole gap is stated after them.
 *
 * With nothing priced there is no second share to contrast, so the line states
 * the token half and says why the other half is missing rather than printing a
 * zero. No prompt tokens at all means no line.
 */
function cacheReadLine(report) {
  const share = report.insights?.cacheReadShare;
  if (share == null) return null;
  const tokens = `Cache reads are ${(share * 100).toFixed(1)}% of prompt tokens`;
  const byClass = report.total?.usdByClass;
  const totalUsd = report.total?.usd || 0;
  if (!byClass || !totalUsd) return `${tokens}; nothing in this window is priced, so there is no cost share to set against that.`;
  const costShare = (byClass.cacheRead || 0) / totalUsd;
  return `${tokens} but ${Math.round(costShare * 100)}% of estimated cost — a cache read bills at ${CACHE_READ_MULTIPLIER}x the input rate.`;
}

// Two rows a side in the terminal: the block sits inside the summary stanza,
// where a longer list would push the readings it qualifies off a screen.
const CHANGED_ROW_LIMIT = 2;

/** A delta with its direction in front of it, so a column of them scans. */
function signedUsd(value) {
  return `${value < 0 ? "-" : "+"}${formatUsd(Math.abs(value))}`;
}

function windowPair(days) {
  return `last ${days} day${days === 1 ? "" : "s"} vs previous ${days}`;
}

/**
 * Where the money moved between the two windows a trend compared. "Estimated
 * spend rose 40%" with no subject is a reading an operator has to go somewhere
 * else to finish, and `analyzeTrend` already ranks the per-key dollar deltas
 * that finish it.
 *
 * Descriptive only: a row at the top of this list is where the money moved, not
 * the reason it moved, and the closing line says so. No trend, or a trend where
 * nothing moved, prints nothing rather than a heading over an empty list.
 */
function whatChangedLines(trend, labels) {
  const models = (trend?.drivers?.byModel || []).slice(0, CHANGED_ROW_LIMIT);
  const projects = (trend?.drivers?.byProject || []).slice(0, CHANGED_ROW_LIMIT);
  if (!models.length && !projects.length) return [];
  const pct = trend.deltaPct == null ? "n/a" : `${(trend.deltaPct * 100).toFixed(1)}%`;
  const lines = [`What changed: ${windowPair(trend.days)} · ${formatUsd(trend.previous?.report?.total?.usd || 0)} → ${formatUsd(trend.current?.report?.total?.usd || 0)} (${pct})`];
  for (const row of models) lines.push(`  model    ${String(row.model).padEnd(28)} ${signedUsd(row.deltaUsd)}`);
  for (const row of projects) lines.push(`  project  ${displayProject(row.id, labels).padEnd(28)} ${signedUsd(row.deltaUsd)}`);
  lines.push("  Where the money moved between those windows, not why it moved; compare tagged, matched task windows before attributing it to a change.");
  return lines;
}

// The multiple of the median day that makes a day worth naming. Below it the
// peak is just the busiest day of a normal week; at or above it, something
// happened that day and the report should point at it.
const PEAK_DAY_RATIO = 2;

/**
 * What the window costs per day, and what that pace comes to over a month. A
 * total is not a rate: the same $5,000 is unremarkable over a quarter and worth
 * stopping for over a week, and the report has to say which this is. Stated as a
 * pace on the workload that already ran — never a forecast, never a bill.
 */
function runRateLine(report) {
  const rate = report.insights?.runRate;
  if (!rate) return null;
  const peak = rate.peakDay;
  const anomaly = peak?.ratioToMedian != null && peak.ratioToMedian >= PEAK_DAY_RATIO
    ? ` · peak ${peak.day} ${formatUsd(peak.usd)} (${peak.ratioToMedian.toFixed(1)}x the median day)`
    : "";
  return `Run rate: ${formatUsd(rate.usdPerDay)}/day over ${rate.days} active day(s) · ~${formatPaceUsd(rate.projectedMonthlyUsd)}/${PROJECTION_DAYS}d at this pace${anomaly}`;
}

/**
 * The shape of a turn, not just its average. The gap between the median and the
 * mean is the whole reading: when a handful of turns costs twenty times the
 * usual one, the mean describes no turn that ever ran.
 */
function perTurnLine(report) {
  const turn = report.insights?.perTurnUsd;
  if (!turn) return null;
  return `Cost per turn: median ${formatFineUsd(turn.p50)} · mean ${formatFineUsd(turn.mean)} · p90 ${formatFineUsd(turn.p90)}`;
}

/**
 * `labels` are the local names from `agent-finops label`, keyed by project id.
 * They are optional in both directions: an unlabelled id prints as itself, and a
 * caller with no labels file at all passes nothing.
 *
 * `trend` is optional context this report cannot hold on its own: the same
 * `analyzeTrend` result the hotspot rules read, used only to name what moved.
 * Absent — a caller with no history, or one that never asked for it — the report
 * is exactly what it was before.
 */
export function humanReport(report, labels = {}, trend = null) {
  const number = tokenFormat;
  const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
  const u = report.total.usage;
  const byClass = costClassLine(report);
  const runRate = runRateLine(report);
  const perTurn = perTurnLine(report);
  const cacheRead = cacheReadLine(report);
  const lines = [
    "agent-finops — local-only estimate",
    `Scope: ${report.scope.recordsAfterDateFilter.toLocaleString()} usage records before keep-last deduplication`,
    `Estimated cost: ${usd.format(report.total.usd)}${report.total.unpricedTokens ? " (partial; unpriced models present)" : ""}`,
    ...(runRate ? [runRate] : []),
    // Directly under the rate: "spend rose" and "here is what rose" are one
    // reading, and splitting them across the report makes the first unusable.
    ...whatChangedLines(trend, labels),
    `Tokens: ${number.format(u.total)}  input ${number.format(u.input)}  cache-write ${number.format(u.cacheCreate)}  cache-read ${number.format(u.cacheRead)}  output ${number.format(u.output)}`,
    ...(byClass ? [byClass] : []),
    ...(cacheRead ? [cacheRead] : []),
    ...(perTurn ? [perTurn] : []),
    "",
    "By model:",
  ];
  for (const [model, value] of Object.entries(report.byModel)) {
    lines.push(`  ${model.padEnd(24)} ${usd.format(value.usd).padStart(10)}  ${number.format(value.usage.total).padStart(12)} tokens  ${value.requests} turns`);
  }
  // Where the work happened, which is the dimension anyone running several agent
  // workspaces at once actually steers by. A project id is a salted local
  // fingerprint and never a path, so it is only a name once someone gives it one.
  if (report.topProjects?.length) {
    lines.push("", "By project:");
    for (const value of report.topProjects) {
      lines.push(`  ${displayProject(value.id, labels).padEnd(28)} ${usd.format(value.usd).padStart(10)}  ${number.format(value.usage.total).padStart(12)} tokens  ${value.requests} turns`);
    }
    lines.push("  Project paths are never stored or printed. Use `agent-finops label PROJECT_ID \"Name\"` to label an id locally.");
  }
  if (report.topSessions.length) {
    lines.push("", "Top anonymous sessions:");
    for (const value of report.topSessions) lines.push(sessionLine(value, labels));
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
