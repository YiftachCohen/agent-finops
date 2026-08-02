import test from "node:test";
import assert from "node:assert/strict";
import { buildReport, compareSnapshots, hotspotAnalysis, humanComparison, humanHotspots, humanReport, humanTools } from "../src/report.mjs";

function record(overrides = {}) {
  return {
    source: "aabbccddeeff",
    messageId: "m1",
    requestId: "r1",
    model: "claude-sonnet-4-6",
    timestamp: "2026-08-01T10:00:00Z",
    usage: { input: 100, cacheCreate: 200, cacheRead: 300, output: 400 },
    ...overrides,
  };
}

test("keeps final streaming usage record and reports cache breakdown", () => {
  const first = record({ usage: { input: 100, cacheCreate: 200, cacheRead: 300, output: 10 } });
  const final = record({ usage: { input: 100, cacheCreate: 200, cacheRead: 300, output: 400 } });
  const report = buildReport([first, final]);
  assert.equal(report.total.usage.total, 1000);
  assert.equal(report.diagnostics.duplicatesDropped, 1);
  assert.equal(report.total.requests, 1);
  assert.equal(report.insights.cacheReadShare, 0.5);
  assert.match(humanReport(report), /claude-sonnet-4-6/);
});

test("unpriced models retain tokens but never receive invented cost", () => {
  const report = buildReport([record({ model: "claude-internal-preview" })]);
  assert.equal(report.total.usd, 0);
  assert.equal(report.total.unpricedTokens, 1000);
  assert.match(humanReport(report), /unpriced models/);
});

// Tokens and dollars are not the same split: a cache read costs 0.1x input and
// a 1-hour write 2x, so every bucket carries the dollar breakdown too.
const CHARGED_CLASSES = ["input", "cacheWrite", "cacheRead", "output"];
const chargedTotal = (usdByClass) => CHARGED_CLASSES.reduce((sum, key) => sum + usdByClass[key], 0);

test("every bucket's per-class dollars add up to that bucket's estimate", () => {
  const report = buildReport([
    record({ usage: { input: 1e6, cacheCreate: 1e6, cacheCreate1h: 6e5, cacheCreate5m: 4e5, cacheRead: 1e6, output: 1e6 } }),
    record({ messageId: "m2", requestId: "r2", model: "claude-opus-5", source: "ffeeddccbbaa", project: "p2", timestamp: "2026-08-02T10:00:00Z", usage: { input: 5e5, cacheCreate: 0, cacheRead: 2e6, output: 1e5 } }),
  ]);
  const buckets = [
    report.total,
    ...Object.values(report.byModel),
    ...Object.values(report.byDay),
    ...report.topSessions,
    ...report.topProjects,
  ];
  assert.equal(buckets.length, 9);
  for (const value of buckets) {
    assert.deepEqual(Object.keys(value.usdByClass).sort(), ["cacheRead", "cacheWrite", "cacheWrite1h", "cacheWrite5m", "input", "output"]);
    assert.ok(Math.abs(chargedTotal(value.usdByClass) - value.usd) < 1e-9);
    assert.equal(value.usdByClass.output, value.outputUsd);
    // The TTL rows break the cache-write total down; they never extend it.
    assert.ok(value.usdByClass.cacheWrite1h + value.usdByClass.cacheWrite5m <= value.usdByClass.cacheWrite + 1e-12);
  }
  assert.ok(Math.abs(report.insights.costClassShares.output - report.insights.outputCostShare) < 1e-12);
  assert.ok(Math.abs(CHARGED_CLASSES.reduce((sum, key) => sum + report.insights.costClassShares[key], 0) - 1) < 1e-9);
  assert.ok(Math.abs(report.insights.cacheWrite1hShare - 0.6 * 2 / (0.6 * 2 + 0.4 * 1.25)) < 1e-9);
});

test("the cost-by-class line ranks dollars, not tokens, and names the 1-hour write share", () => {
  // Cache reads are four times the tokens of any other class here and still
  // third by cost, which is the whole reason this line exists next to `Tokens:`.
  const report = buildReport([record({ usage: { input: 1e5, cacheCreate: 1e6, cacheCreate1h: 6e5, cacheCreate5m: 4e5, cacheRead: 4e6, output: 1e5 } })]);
  const line = humanReport(report).split("\n").find((row) => row.startsWith("Cost by class:"));
  assert.equal(line, "Cost by class: cache-write $5.10 (63%) · output $1.50 (19%) · cache-read $1.20 (15%) · input $0.30 (4%) (1h writes 71% of cache-write cost)");
  assert.ok(report.total.usage.cacheRead > report.total.usage.cacheCreate, "cache read leads on tokens");
  assert.ok(report.total.usdByClass.cacheRead < report.total.usdByClass.cacheWrite, "and trails on dollars");

  // With no cache writes there is no TTL split to report, so the parenthetical
  // is absent rather than reading 0%.
  const noWrites = buildReport([record({ usage: { input: 1e6, cacheCreate: 0, cacheRead: 0, output: 1e6 } })]);
  assert.equal(
    humanReport(noWrites).split("\n").find((row) => row.startsWith("Cost by class:")),
    "Cost by class: output $15.00 (83%) · input $3.00 (17%) · cache-write $0.00 (0%) · cache-read $0.00 (0%)",
  );

  // Nothing priced means no line at all: a row of zeroes would read as a split.
  assert.ok(!humanReport(buildReport([record({ model: "claude-internal-preview" })])).includes("Cost by class:"));
  assert.ok(!humanReport(buildReport([])).includes("Cost by class:"));
});

test("per-turn cost is described by its distribution, never by the turn list", () => {
  // Ten priced turns costing $1.50 to $15.00, so mean, median, and p90 are all
  // different numbers and a mistaken percentile cannot pass by coincidence.
  const turns = Array.from({ length: 10 }, (_, i) => record({
    messageId: `m${i}`,
    requestId: `r${i}`,
    usage: { input: 0, cacheCreate: 0, cacheRead: 0, output: (i + 1) * 1e5 },
  }));
  const report = buildReport(turns);
  assert.ok(Math.abs(report.insights.perTurnUsd.mean - 8.25) < 1e-9);
  // Nearest rank, no interpolation: each figure is a turn that happened.
  assert.ok(Math.abs(report.insights.perTurnUsd.p50 - 7.5) < 1e-9);
  assert.ok(Math.abs(report.insights.perTurnUsd.p90 - 13.5) < 1e-9);
  assert.deepEqual(Object.keys(report.insights.perTurnUsd).sort(), ["mean", "p50", "p90"]);
  // Three numbers, not a sample: the per-turn list must not survive into the
  // report object any more than the record list does.
  for (const value of Object.values(report.insights.perTurnUsd)) assert.equal(typeof value, "number");

  // An unpriced turn is not a $0 turn, so it stays out of the distribution.
  const mixed = buildReport([...turns, record({ messageId: "mx", requestId: "rx", model: "claude-internal-preview" })]);
  assert.deepEqual(mixed.insights.perTurnUsd, report.insights.perTurnUsd);
  assert.equal(mixed.total.requests, 11);

  assert.equal(buildReport([record({ model: "claude-internal-preview" })]).insights.perTurnUsd, null);
  assert.equal(buildReport([]).insights.perTurnUsd, null);
  // One priced turn is a distribution of one, not a missing reading.
  const single = buildReport([record()]);
  assert.equal(single.insights.perTurnUsd.p50, single.total.usd);
  assert.equal(single.insights.perTurnUsd.p90, single.total.usd);
});

test("a session carries the project it ran under and the context it hauls per turn", () => {
  const turn = (id, source, project, usage) => record({ messageId: id, requestId: id, source, project, usage });
  const report = buildReport([
    turn("m1", "aaaaaaaaaaaa", "p1", { input: 100, cacheCreate: 200, cacheRead: 300, output: 400 }),
    turn("m2", "aaaaaaaaaaaa", "p1", { input: 100, cacheCreate: 200, cacheRead: 301, output: 400 }),
    // A session is one log file under one project directory, so it cannot span
    // projects. If two records disagree the first seen wins rather than the last.
    turn("m3", "aaaaaaaaaaaa", "p2", { input: 100, cacheCreate: 200, cacheRead: 300, output: 400 }),
    turn("m4", "bbbbbbbbbbbb", null, { input: 1000, cacheCreate: 0, cacheRead: 0, output: 1 }),
  ]);
  const first = report.topSessions.find((session) => session.id === "aaaaaaaaaaaa");
  assert.equal(first.project, "p1");
  assert.equal(first.requests, 3);
  // (600 + 601 + 600) / 3 rounds to a whole token; the prompt is the context
  // hauled into every turn, so cache reads count toward it.
  assert.equal(first.avgPromptTokens, 600);

  const unattributed = report.topSessions.find((session) => session.id === "bbbbbbbbbbbb");
  assert.equal(unattributed.project, null, "a record with no project id leaves the session unattributed");
  assert.equal(unattributed.avgPromptTokens, 1000);
  // Sessions and projects stay separate rankings over the same records.
  assert.deepEqual(report.topProjects.map((project) => project.id).sort(), ["<unknown-project>", "p1", "p2"]);
});

test("an empty or entirely unpriced report reports no class shares instead of zeroes", () => {
  const report = buildReport([record({ model: "claude-internal-preview" })]);
  assert.equal(report.total.usd, 0);
  assert.equal(report.total.unpricedTokens, 1000);
  // Unpriced tokens are counted as tokens and never given a dollar class.
  assert.deepEqual(report.total.usdByClass, { input: 0, cacheWrite: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 0 });
  assert.equal(report.insights.costClassShares, null);
  assert.equal(report.insights.cacheWrite1hShare, null);

  // A mixed report prices only the priced half.
  const mixed = buildReport([record({ model: "claude-internal-preview" }), record({ messageId: "m2", requestId: "r2" })]);
  const priced = buildReport([record({ messageId: "m2", requestId: "r2" })]);
  assert.deepEqual(mixed.total.usdByClass, priced.total.usdByClass);
  assert.equal(mixed.total.unpricedTokens, 1000);
});

test("fractional tool attribution divides dollars by class, so tool rows still sum to the turn", () => {
  const call = record({ tools: ["Bash", "mcp__issues__search"] });
  const followOn = record({
    messageId: "m2",
    requestId: "r2",
    priorTools: ["Bash", "mcp__issues__search"],
    usage: { input: 1e6, cacheCreate: 1e6, cacheCreate1h: 6e5, cacheCreate5m: 4e5, cacheRead: 1e6, output: 1e6 },
  });
  const report = buildReport([call, followOn], { toolLimit: 10 });
  const unsplit = buildReport([followOn]).total.usdByClass;
  assert.equal(report.topTools.length, 2);
  for (const key of Object.keys(unsplit)) {
    const summed = report.topTools.reduce((sum, tool) => sum + tool.usdByClass[key], 0);
    assert.ok(Math.abs(summed - unsplit[key]) < 1e-9, key);
  }
  for (const tool of report.topTools) assert.ok(Math.abs(chargedTotal(tool.usdByClass) - tool.usd) < 1e-9);
});

test("usdPerCall and soloShare are derived per tool, null rather than a divide by zero", () => {
  // Bash is called once and is the sole prior tool for the following turn, so
  // it gets the whole turn's cost and a 100% solo share.
  const call = record({ tools: ["Bash"] });
  const followOn = record({
    messageId: "m2",
    requestId: "r2",
    priorTools: ["Bash"],
    usage: { input: 1e5, cacheCreate: 0, cacheRead: 0, output: 0 },
  });
  const report = buildReport([call, followOn], { toolLimit: 10 });
  const bash = report.topTools.find((tool) => tool.name === "Bash");
  assert.equal(bash.calls, 1);
  assert.ok(Math.abs(bash.usdPerCall - bash.usd / bash.calls) < 1e-12);
  assert.equal(bash.soloShare, 1);

  // A tool can appear in a cohort's `priorTools` without ever being counted as
  // a call in the window a report is built over (its call fell outside the
  // window, or came from a different scan). `calls` stays 0 and `usdPerCall`
  // is null rather than a division by zero.
  const windowedFollowOn = record({
    messageId: "m3",
    requestId: "r3",
    priorTools: ["Grep"],
    usage: { input: 1e5, cacheCreate: 0, cacheRead: 0, output: 0 },
  });
  const windowed = buildReport([windowedFollowOn], { toolLimit: 10 });
  const grep = windowed.topTools.find((tool) => tool.name === "Grep");
  assert.equal(grep.calls, 0);
  assert.equal(grep.usdPerCall, null);
  // Its cost is still fully attributed (a solo cohort), so soloShare is 1
  // despite the call count being unknown.
  assert.equal(grep.soloShare, 1);

  // An unpriced turn leaves `usd` at 0, so soloShare has nothing to be a share
  // of and is null rather than 0/0. The call was still counted, so usdPerCall
  // is a real (zero) rate rather than null — the call happened, it was just
  // never priced.
  const unpriced = buildReport([record({ tools: ["Bash"] }), record({ messageId: "m2", requestId: "r2", priorTools: ["Bash"], model: "claude-internal-preview" })], { toolLimit: 10 });
  const unpricedBash = unpriced.topTools.find((tool) => tool.name === "Bash");
  assert.equal(unpricedBash.usd, 0);
  assert.equal(unpricedBash.usdPerCall, 0);
  assert.equal(unpricedBash.soloShare, null);
});

test("humanTools renders the per-call and solo-share columns, including n/a", () => {
  const shared = buildReport([
    record({ tools: ["Bash", "mcp__issues__search"] }),
    record({ messageId: "m2", requestId: "r2", priorTools: ["Bash", "mcp__issues__search"], usage: { input: 1e6, cacheCreate: 0, cacheRead: 0, output: 1e6 } }),
  ], { toolLimit: 10 });
  const rendered = humanTools(shared.topTools);
  // Neither tool was ever the sole prior tool, so both read solo 0%.
  assert.match(rendered, /Bash\s+\$9\.00\s+1,000,000 tokens\s+1 call\(s\)\s+1 follow-on turn\(s\)\s+\$9\.00\/call\s+solo 0%/);
  assert.match(rendered, /the correlation is less diluted/);

  // A tool that only ever shows up as a follow-on turn's prior tool for an
  // unpriced model has no counted call and no priced cost: both derived
  // fields read n/a rather than a divide-by-zero.
  const noCallNoCost = buildReport([record({ priorTools: ["Grep"], model: "claude-internal-preview" })], { toolLimit: 10 });
  assert.match(humanTools(noCallNoCost.topTools), /Grep\s+\$0\.00\s+1,000 tokens\s+0 call\(s\)\s+1 follow-on turn\(s\)\s+n\/a\s+solo n\/a/);
});

test("a snapshot taken before per-class dollars existed still compares", () => {
  // Tags are stored report shapes. An index written by an older release has no
  // `usdByClass` anywhere, and a comparison must not fault on its absence.
  const legacy = { scope: {}, total: { usd: 10, outputUsd: 4, usage: { total: 1000 } }, byModel: { "claude-sonnet-4-6": { usd: 10 } }, insights: { cacheReadShare: 0.5, outputCostShare: 0.4 } };
  const current = buildReport([record()]);
  const comparison = compareSnapshots("legacy", legacy, "current", current);
  assert.equal(comparison.deltaUsd, current.total.usd - 10);
  assert.match(humanComparison(comparison), /agent-finops compare/);
  // And in the other direction: a current snapshot compared against itself.
  assert.equal(compareSnapshots("a", current, "b", current).deltaUsd, 0);
});

test("the report exposes dedup counts, never the per-turn record list", () => {
  const session = "deadbeefcafe";
  const report = buildReport([
    record({ source: session }),
    record({ source: session, messageId: "m2", requestId: "r2" }),
  ]);
  assert.deepEqual(Object.keys(report.diagnostics).sort(), ["duplicatesDropped", "missingIds"]);

  // `report --json` is the artifact people share, so the only place a session
  // fingerprint may appear is the ranked list; a per-turn array would leak the
  // shape of a session (turn count, timing, ids) alongside it.
  const paths = [];
  const walk = (value, path) => {
    if (typeof value === "string") {
      if (value === session || value === "m1" || value === "r1") paths.push(path);
      return;
    }
    if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`);
  };
  walk(JSON.parse(JSON.stringify(report)), "report");
  assert.deepEqual(paths, ["report.topSessions.0.id"]);
});

test("a model, session, or tool name that names a prototype property cannot corrupt a report", () => {
  // These keys arrive from a log file. On a plain accumulator object they read
  // back as a truthy inherited value, so the bucket is never created and the
  // first record accumulated into it throws — permanently, because the record
  // is already in the index.
  const report = buildReport([
    record({ model: "__proto__", source: "__proto__", tools: ["__proto__"], priorTools: ["constructor"] }),
    record({ messageId: "m2", requestId: "r2" }),
  ]);
  assert.equal(report.total.requests, 2);
  assert.equal(report.byModel["claude-sonnet-4-6"].requests, 1);
  assert.equal(report.byModel.__proto__.requests, 1);
  assert.equal(report.topSessions.find((session) => session.id === "__proto__").requests, 1);
  // No bucket absorbed another bucket's tokens.
  assert.equal(report.total.usage.total, 2000);
  assert.equal(report.byModel["claude-sonnet-4-6"].usage.total, 1000);
});

test("date filtering excludes records outside the requested interval", () => {
  const report = buildReport([record({ timestamp: "2026-07-01T10:00:00Z" }), record({ messageId: "m2", requestId: "r2", timestamp: "2026-08-01T10:00:00Z" })], { sinceMs: Date.parse("2026-08-01T00:00:00Z") });
  assert.equal(report.total.requests, 1);
  assert.equal(report.scope.recordsAfterDateFilter, 1);
});

test("an absolute window is half-open, so two adjacent windows partition the records", () => {
  // One turn on each boundary and one strictly inside. The `to` boundary must
  // belong to the next window, or a month-over-month comparison counts the
  // midnight turn twice.
  const at = (timestamp, id) => record({ timestamp, messageId: `m${id}`, requestId: `r${id}` });
  const records = [
    at("2026-06-30T23:59:59Z", 0),
    at("2026-07-01T00:00:00Z", 1),
    at("2026-07-15T12:00:00Z", 2),
    at("2026-08-01T00:00:00Z", 3),
  ];
  const july = buildReport(records, { sinceMs: Date.parse("2026-07-01T00:00:00Z"), untilMs: Date.parse("2026-08-01T00:00:00Z") });
  assert.equal(july.total.requests, 2, "the record exactly at `from` is kept and the one exactly at `to` is not");
  assert.equal(july.scope.recordsAfterDateFilter, 2);
  assert.deepEqual(Object.keys(july.byDay), ["2026-07-01", "2026-07-15"]);

  const august = buildReport(records, { sinceMs: Date.parse("2026-08-01T00:00:00Z") });
  assert.equal(august.total.requests, 1);
  // Every record is in exactly one of the three windows.
  const june = buildReport(records, { untilMs: Date.parse("2026-07-01T00:00:00Z") });
  assert.equal(june.total.requests, 1);
  assert.equal(june.total.requests + july.total.requests + august.total.requests, records.length);

  // The resolved window travels with the report, so a tag can record it.
  assert.equal(july.scope.sinceMs, Date.parse("2026-07-01T00:00:00Z"));
  assert.equal(july.scope.untilMs, Date.parse("2026-08-01T00:00:00Z"));
  assert.equal(august.scope.untilMs, null);

  // A record with no usable timestamp cannot be placed in a window at all, so a
  // windowed report must exclude it rather than silently attribute it.
  assert.equal(buildReport([at(null, 9)], { untilMs: Date.parse("2026-08-01T00:00:00Z") }).total.requests, 0);
  assert.equal(buildReport([at(null, 9)]).total.requests, 1);
});

// A hotspot report is a set of thresholds. Each one is asserted at and below
// its boundary so a later edit cannot quietly move a recommendation.
function analyzable(overrides = {}) {
  return {
    total: { usd: 100, unpricedTokens: 0 },
    byModel: {},
    topSessions: [],
    topTools: [],
    insights: { cacheReadShare: null, outputCostShare: null },
    ...overrides,
  };
}

const kinds = (report) => hotspotAnalysis(report).recommendations.map((item) => `${item.kind}:${item.severity}`);

test("model concentration is called out only once one model owns half the spend", () => {
  const model = (usd) => ({ "claude-opus-5": { usd }, "claude-haiku-4-5": { usd: 100 - usd } });
  assert.deepEqual(kinds(analyzable({ byModel: model(49) })), []);
  assert.deepEqual(kinds(analyzable({ byModel: model(50) })), ["model-concentration:high"]);
  // With nothing priced there is no share to reason about.
  assert.deepEqual(kinds(analyzable({ byModel: model(50), total: { usd: 0 } })), []);
});

test("output-cost and the cache share fallback follow their own thresholds", () => {
  assert.deepEqual(kinds(analyzable({ insights: { outputCostShare: 0.1499, cacheReadShare: null } })), []);
  assert.deepEqual(kinds(analyzable({ insights: { outputCostShare: 0.15, cacheReadShare: null } })), ["output-cost:medium"]);
  // With nothing priced there are no cache dollars to compare, so the token
  // share is what remains. Cache is always reported when it is measurable; only
  // its severity moves, because caching that pays for itself is a reason not to
  // change TTL policy.
  assert.deepEqual(kinds(analyzable({ insights: { outputCostShare: null, cacheReadShare: 0.79 } })), ["cache:medium"]);
  assert.deepEqual(kinds(analyzable({ insights: { outputCostShare: null, cacheReadShare: 0.8 } })), ["cache:info"]);
  assert.match(humanHotspots(hotspotAnalysis(analyzable({ insights: { outputCostShare: null, cacheReadShare: 0.9 } }))), /net positive on tokens/);
});

// Once dollars exist the cache verdict is an economic one, not a token share:
// reads are billed at a tenth of the input rate, so the same tokens uncached
// would have cost ten times as much and the saving is the other nine tenths.
function cacheReport({ cacheWrite, cacheRead, cacheWrite1hShare = null, cacheReadShare = 0.5 }) {
  return analyzable({
    total: { usd: 100, usdByClass: { input: 0, cacheWrite, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead, output: 0 } },
    insights: { outputCostShare: null, cacheReadShare, cacheWrite1hShare },
  });
}

test("cache economics compares write cost against what reads saved", () => {
  const positive = hotspotAnalysis(cacheReport({ cacheWrite: 10, cacheRead: 5 })).recommendations[0];
  assert.equal(positive.kind, "cache");
  assert.equal(positive.severity, "info");
  // $5 of reads would have been $50 uncached, so the saving is $45 against $10.
  assert.match(positive.evidence, /Cache writes cost \$10\.00 and saved ≈ \$45\.00 against uncached reads/);
  assert.match(positive.action, /net positive/);

  const negative = hotspotAnalysis(cacheReport({ cacheWrite: 50, cacheRead: 5, cacheWrite1hShare: 0.62 })).recommendations[0];
  assert.equal(negative.severity, "medium");
  assert.match(negative.evidence, /Cache writes cost \$50\.00 against ≈ \$45\.00 saved on reads/);
  // 1-hour writes are named only when they dominate the write bill.
  assert.match(negative.evidence, /1-hour writes are 62\.0% of that write cost/);
  assert.ok(!hotspotAnalysis(cacheReport({ cacheWrite: 50, cacheRead: 5, cacheWrite1hShare: 0.2 })).recommendations[0].evidence.includes("1-hour writes"));
  assert.match(negative.action, /session restarts/);

  // A high read share does not overrule the dollars: reads can dominate the
  // token mix while the writes that produced them cost more than they recover.
  assert.deepEqual(kinds(cacheReport({ cacheWrite: 50, cacheRead: 5, cacheReadShare: 0.95 })), ["cache:medium"]);
  // Cents on both sides are an ordering, not money; the share reading returns.
  assert.match(hotspotAnalysis(cacheReport({ cacheWrite: 0.5, cacheRead: 0.01, cacheReadShare: 0.9 })).recommendations[0].evidence, /Cache reads are 90\.0% of prompt tokens/);
});

test("model concentration re-prices the same tokens at the cheaper sibling's rate", () => {
  // 1M output on opus-5 is $25; the same tokens at sonnet-5 list price are $15.
  const usage = { input: 0, cacheCreate: 0, cacheCreate1h: 0, cacheCreate5m: 0, cacheRead: 0, output: 1e6, total: 1e6 };
  const finding = hotspotAnalysis(analyzable({ total: { usd: 25 }, byModel: { "claude-opus-5": { usd: 25, usage } } })).recommendations[0];
  assert.equal(finding.kind, "model-concentration");
  assert.match(finding.evidence, /Re-pricing the same tokens at claude-sonnet-5 rates ≈ \$10\.00 less over this window/);
  // The counterfactual holds usage fixed, so it is stated as a ceiling.
  assert.match(finding.evidence, /an upper bound, not a promise/);

  // Cache writes and reads are re-priced on the same TTL multipliers: at sonnet
  // list price a 1h write is 2x $3/M and a read a tenth of it.
  const mixed = { input: 1e6, cacheCreate: 1e6, cacheCreate1h: 1e6, cacheCreate5m: 0, cacheRead: 1e6, output: 0, total: 3e6 };
  const opusUsd = 5 + 5 * 2 + 5 * 0.1;
  const sonnetUsd = 3 + 3 * 2 + 3 * 0.1;
  const repriced = hotspotAnalysis(analyzable({ total: { usd: opusUsd }, byModel: { "claude-opus-5": { usd: opusUsd, usage: mixed } } })).recommendations[0];
  assert.match(repriced.evidence, new RegExp(`≈ \\$${(opusUsd - sonnetUsd).toFixed(2)} less`));

  // Haiku is the bottom of the ladder, so the share is still reported and the
  // counterfactual is simply absent rather than invented.
  const haiku = hotspotAnalysis(analyzable({ total: { usd: 25 }, byModel: { "claude-haiku-4-5": { usd: 25, usage } } })).recommendations[0];
  assert.equal(haiku.kind, "model-concentration");
  assert.ok(!haiku.evidence.includes("Re-pricing"));
  // An aggregate with no token counts cannot be re-priced at all.
  assert.ok(!hotspotAnalysis(analyzable({ total: { usd: 25 }, byModel: { "claude-opus-5": { usd: 25 } } })).recommendations[0].evidence.includes("Re-pricing"));
});

test("context bloat names one session, and only when the context is both large and expensive", () => {
  const session = (id, avgPromptTokens, usd, requests = 40) => ({ id, avgPromptTokens, usd, requests });
  assert.deepEqual(kinds(analyzable({ topSessions: [session("aabbccddeeff", 149_999, 9)] })), []);
  assert.deepEqual(kinds(analyzable({ topSessions: [session("aabbccddeeff", 150_000, 4.99)] })), []);

  // Severity is the session's share of the window, not its absolute cost. Above
  // $10 the session-outlier rule fires on the same row, which is the point:
  // one says the session is expensive, the other says the context is why.
  assert.deepEqual(kinds(analyzable({ topSessions: [session("aabbccddeeff", 150_000, 19.99)] })), ["session-outlier:medium", "context-bloat:medium"]);
  assert.deepEqual(kinds(analyzable({ topSessions: [session("aabbccddeeff", 150_000, 5)] })), ["context-bloat:medium"]);
  const worst = hotspotAnalysis(analyzable({ topSessions: [session("aabbccddeeff", 210_000, 61, 42), session("ffeeddccbbaa", 300_000, 30)] }));
  assert.deepEqual(worst.recommendations.map((item) => `${item.kind}:${item.severity}`), ["session-outlier:medium", "context-bloat:high"]);
  // One row, for the costliest offender, however many sessions qualify.
  assert.equal(worst.recommendations.filter((item) => item.kind === "context-bloat").length, 1);
  const bloat = worst.recommendations.find((item) => item.kind === "context-bloat");
  assert.equal(bloat.evidence, "Session aabbccddeeff averaged 210K prompt tokens per turn across 42 turn(s) (≈$61.00).");
  assert.match(bloat.action, /compact earlier/);
});

test("session and MCP outliers need real money before they are raised", () => {
  assert.deepEqual(kinds(analyzable({ topSessions: [{ id: "aabbccddeeff", usd: 9.99 }] })), []);
  assert.deepEqual(kinds(analyzable({ topSessions: [{ id: "aabbccddeeff", usd: 10 }] })), ["session-outlier:medium"]);

  const mcp = (usd, total) => analyzable({ total: { usd: total }, topTools: [{ name: "mcp__issues__search", usd, followOnRequests: 3 }] });
  assert.deepEqual(kinds(mcp(9.99, 100)), []);
  // Severity splits on the MCP's share of total spend, not on its absolute cost.
  assert.deepEqual(kinds(mcp(10, 100)), ["mcp-follow-on-cost:medium"]);
  assert.deepEqual(kinds(mcp(20, 100)), ["mcp-follow-on-cost:high"]);
  // Only conventional mcp__ rows qualify; a built-in tool is not an MCP finding.
  assert.deepEqual(kinds(analyzable({ topTools: [{ name: "Read", usd: 99, followOnRequests: 3 }] })), []);
});

test("an expensive Bash cohort points at the local output filter and quotes it only when it has run", () => {
  const withBash = (usd) => analyzable({ topTools: [{ name: "Bash", usd, followOnRequests: 12 }] });
  assert.deepEqual(kinds(withBash(24.99)), []);
  assert.deepEqual(kinds(withBash(25)), ["bash-output-filter:medium"]);

  const bare = hotspotAnalysis(withBash(40)).recommendations[0];
  assert.match(bare.evidence, /Bash carries \$40\.00 in equally apportioned follow-on request cost across 12 turn\(s\)/);
  assert.match(bare.evidence, /correlation for prioritization, not proof that the output caused the cost/);
  assert.ok(!bare.evidence.includes("already removed"));
  assert.match(bare.action, /agent-finops hook-config/);
  assert.match(bare.action, /agent-finops filter-report/);

  const measured = hotspotAnalysis(withBash(40), { filterStats: { events: 9, rawChars: 500_000, sentChars: 100_000, savedChars: 400_000, estimatedTokensSaved: 100_000 } }).recommendations[0];
  assert.match(measured.evidence, /already removed ~100,000 input tokens across 9 filtered result\(s\)/);
  // A ledger that exists but has removed nothing has nothing to report.
  assert.ok(!hotspotAnalysis(withBash(40), { filterStats: { events: 0, savedChars: 0, estimatedTokensSaved: 0 } }).recommendations[0].evidence.includes("already removed"));
});

test("spend acceleration is raised only with a trend, a real jump, and real money", () => {
  const trend = (deltaPct, currentUsd, drivers = undefined) => ({
    days: 7,
    deltaPct,
    drivers,
    current: { report: { total: { usd: currentUsd } } },
    previous: { report: { total: { usd: currentUsd / (1 + deltaPct) } } },
  });
  // Absent extras is the backward-compatible default: no trend, no finding.
  assert.deepEqual(kinds(analyzable()), []);
  assert.deepEqual(hotspotAnalysis(analyzable(), { trend: trend(0.49, 100) }).recommendations, []);
  assert.deepEqual(hotspotAnalysis(analyzable(), { trend: trend(0.5, 9.99) }).recommendations, []);
  // A window with no previous spend has no percentage to compare.
  assert.deepEqual(hotspotAnalysis(analyzable(), { trend: { days: 7, deltaPct: null, current: { report: { total: { usd: 500 } } } } }).recommendations, []);

  const finding = hotspotAnalysis(analyzable(), { trend: trend(0.5, 150, { byModel: [{ model: "claude-opus-5", deltaUsd: 40 }] }) }).recommendations[0];
  assert.equal(finding.kind, "spend-acceleration");
  assert.equal(finding.severity, "medium");
  assert.match(finding.evidence, /rose 50\.0% against the previous 7-day window, \$100\.00 → \$150\.00/);
  assert.match(finding.evidence, /largest model-level change is claude-opus-5 at \$40\.00/);
  assert.match(finding.action, /before attributing the change to anything/);
  // No drivers, no attribution sentence — the change is still reported.
  assert.ok(!hotspotAnalysis(analyzable(), { trend: trend(0.5, 150) }).recommendations[0].evidence.includes("largest model-level change"));
});

test("a report with nothing over a threshold says so instead of inventing advice", () => {
  assert.equal(humanHotspots(hotspotAnalysis(analyzable())), "No cost hotspots found in this period.");
  // Extras are optional in both directions: empty ones read like none at all.
  assert.equal(humanHotspots(hotspotAnalysis(analyzable(), {})), "No cost hotspots found in this period.");
});
