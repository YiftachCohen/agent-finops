import test from "node:test";
import assert from "node:assert/strict";
import { buildReport, compareSnapshots, hotspotAnalysis, humanComparison, humanHotspots, humanReport, humanSessions, humanTools } from "../src/report.mjs";
import { analyzeTrend } from "../src/trends.mjs";

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

// Sonnet 4.6 bills output at $15/M, so one turn of N million output tokens is
// exactly $15N and every figure below is a whole number of dollars.
function outputTurn(day, millions, overrides = {}) {
  return record({
    messageId: `m${day}-${millions}`,
    requestId: `r${day}-${millions}`,
    timestamp: `2026-07-${day}T10:00:00Z`,
    usage: { input: 0, cacheCreate: 0, cacheRead: 0, output: millions * 1e6 },
    ...overrides,
  });
}

test("the run rate is spend per active day, not per day of the calendar span", () => {
  // Three worked days inside a fifteen-day span. Dividing by the span would
  // report a fifth of the pace of the days the agent actually ran, which is the
  // pace anyone projecting forward is asking about.
  const report = buildReport([outputTurn("01", 1), outputTurn("08", 1), outputTurn("15", 1)]);
  const rate = report.insights.runRate;
  assert.equal(rate.days, 3, "the twelve idle days in the span are not days");
  assert.equal(rate.firstDay, "2026-07-01");
  assert.equal(rate.lastDay, "2026-07-15");
  assert.ok(Math.abs(rate.usdPerDay - 15) < 1e-9);
  // A pace, stated as a fixed multiple of the daily rate.
  assert.ok(Math.abs(rate.projectedMonthlyUsd - 450) < 1e-9);
  assert.deepEqual(Object.keys(rate).sort(), ["days", "firstDay", "lastDay", "peakDay", "projectedMonthlyUsd", "usdPerDay"]);

  // A record with no usable timestamp cannot be placed on a day, so it creates
  // no day of its own — but its cost is still the window's, and the rate spreads
  // the whole estimate over the days it could place rather than dropping it.
  const undated = buildReport([outputTurn("01", 1), record({ messageId: "mx", requestId: "rx", timestamp: null, usage: { input: 0, cacheCreate: 0, cacheRead: 0, output: 1e6 } })]);
  assert.equal(undated.total.usd, 30);
  assert.equal(undated.insights.runRate.days, 1);
  assert.ok(Math.abs(undated.insights.runRate.usdPerDay - 30) < 1e-9);

  // Nothing dated at all is no rate rather than a division by zero.
  assert.equal(buildReport([]).insights.runRate, null);
  assert.equal(buildReport([record({ timestamp: null })]).insights.runRate, null);
  // A window that excludes every record has no days either.
  assert.equal(buildReport([outputTurn("01", 1)], { sinceMs: Date.parse("2026-08-01T00:00:00Z") }).insights.runRate, null);
});

test("the peak day is measured against the median day, so one spike cannot hide itself", () => {
  // Nine ordinary days and one that cost three times as much. Against a mean the
  // spike would be part of its own baseline and read as a smaller multiple.
  const days = Array.from({ length: 9 }, (_, i) => outputTurn(String(i + 1).padStart(2, "0"), 1));
  const rate = buildReport([...days, outputTurn("10", 3)]).insights.runRate;
  assert.equal(rate.peakDay.day, "2026-07-10");
  assert.ok(Math.abs(rate.peakDay.usd - 45) < 1e-9);
  assert.ok(Math.abs(rate.peakDay.ratioToMedian - 3) < 1e-9);

  // A flat window has a peak day like any other, at 1x: the ratio is what
  // decides whether it is worth naming, not the existence of a maximum.
  assert.equal(buildReport(days).insights.runRate.peakDay.ratioToMedian, 1);

  // An unpriced window has a median of zero, and a multiple of zero is not a
  // reading. Null rather than an infinity.
  const unpriced = buildReport([outputTurn("01", 1, { model: "claude-internal-preview" })]).insights.runRate;
  assert.equal(unpriced.peakDay.usd, 0);
  assert.equal(unpriced.peakDay.ratioToMedian, null);
});

test("humanReport states the run rate under the cost, and names the peak day only when it is anomalous", () => {
  const report = buildReport([outputTurn("01", 1), outputTurn("02", 3)]);
  const lines = humanReport(report).split("\n");
  // Directly under the estimate: a total nobody can place in time is not a rate.
  assert.equal(lines[2], "Estimated cost: $60.00");
  assert.equal(lines[3], "Run rate: $30.00/day over 2 active day(s) · ~$900/30d at this pace · peak 2026-07-02 $45.00 (3.0x the median day)");

  // Below 2x the median the peak is just the busiest day of a normal window.
  const even = humanReport(buildReport([outputTurn("01", 1), outputTurn("02", 1.2)])).split("\n")[3];
  assert.equal(even, "Run rate: $16.50/day over 2 active day(s) · ~$495/30d at this pace");

  // Under $100 the projection keeps its cents; above it, cents on an
  // extrapolation would claim an accuracy the extrapolation does not have.
  assert.match(humanReport(buildReport([outputTurn("01", 0.1)])), /~\$45\.00\/30d at this pace/);

  // No dated record, no rate line at all — and the report is otherwise intact.
  const undated = humanReport(buildReport([record({ timestamp: null })]));
  assert.ok(!undated.includes("Run rate:"));
  assert.match(undated, /Estimated cost: /);
});

test("humanReport prints the per-turn distribution the dashboard already shows", () => {
  const report = buildReport([outputTurn("01", 1), outputTurn("02", 3)]);
  const line = humanReport(report).split("\n").find((row) => row.startsWith("Cost per turn:"));
  // Three decimals under a dollar and two above, the same split `$/call` uses.
  assert.equal(line, "Cost per turn: median $15.00 · mean $30.00 · p90 $45.00");
  assert.match(humanReport(buildReport([outputTurn("01", 0.001)])), /Cost per turn: median \$0\.015 · mean \$0\.015 · p90 \$0\.015/);

  // Nothing priced is no distribution, so no line rather than a row of zeroes.
  assert.ok(!humanReport(buildReport([record({ model: "claude-internal-preview" })])).includes("Cost per turn:"));
  assert.ok(!humanReport(buildReport([])).includes("Cost per turn:"));
});

test("the cache-read line names both denominators, so a token share cannot read as a cost share", () => {
  // The fixture from the cost-by-class test: cache reads are four times the
  // tokens of any other class and a seventh of the dollars. Printing "96.7%"
  // under "cache-read (15%)" with neither unit stated is the exact confusion
  // this tool exists to remove.
  const report = buildReport([record({ usage: { input: 1e5, cacheCreate: 1e6, cacheCreate1h: 6e5, cacheCreate5m: 4e5, cacheRead: 4e6, output: 1e5 } })]);
  const lines = humanReport(report).split("\n");
  const line = lines.find((row) => row.startsWith("Cache reads are"));
  assert.equal(line, "Cache reads are 78.4% of prompt tokens but 15% of estimated cost — a cache read bills at 0.1x the input rate.");
  // The cost share is the same figure the line directly above it already prints,
  // so the two cannot disagree by a rounding rule or by a denominator.
  assert.match(lines.find((row) => row.startsWith("Cost by class:")), /cache-read \$1\.20 \(15%\)/);
  assert.equal(lines.indexOf(line) - lines.findIndex((row) => row.startsWith("Cost by class:")), 1);

  // The two share readings it replaces are gone from the text and unchanged in
  // the JSON, where tags and other callers read them.
  const text = humanReport(report);
  assert.ok(!text.includes("Cache-read share:"));
  assert.ok(!text.includes("output-cost share"));
  assert.ok(Math.abs(report.insights.cacheReadShare - 4e6 / 5.1e6) < 1e-9);
  assert.ok(Math.abs(report.insights.outputCostShare - 1.5 / 8.1) < 1e-9);

  // With nothing priced there is no second share to set against the first, so
  // the line says why rather than printing a 0%.
  const unpriced = humanReport(buildReport([record({ model: "claude-internal-preview" })])).split("\n").find((row) => row.startsWith("Cache reads are"));
  assert.equal(unpriced, "Cache reads are 50.0% of prompt tokens; nothing in this window is priced, so there is no cost share to set against that.");

  // No prompt tokens at all is no line rather than a share of nothing.
  assert.ok(!humanReport(buildReport([])).includes("Cache reads are"));
});

// Two 2-day windows: previous is 07-28..07-29 and current is 07-30..07-31, with
// today (08-01) outside both. Sonnet 4.6 bills output at $15/M, Haiku 4.5 at
// $5/M, and Opus 4.5 at $25/M, so every figure below is exact.
function movedRecords() {
  const turn = (day, model, project, output) => record({
    messageId: `${day}-${model}-${project}`,
    requestId: `${day}-${model}-${project}`,
    timestamp: `2026-${day}T10:00:00Z`,
    model,
    project,
    usage: { input: 0, cacheCreate: 0, cacheRead: 0, output },
  });
  return [
    turn("07-28", "claude-sonnet-4-6", "p1", 1e6),
    turn("07-30", "claude-sonnet-4-6", "p1", 3e6),
    turn("07-28", "claude-haiku-4-5", "112233445566", 1e6),
    turn("07-30", "claude-haiku-4-5", "112233445566", 2e5),
    turn("07-28", "claude-opus-4-5", "p3", 1e5),
    turn("07-30", "claude-opus-4-5", "p3", 1.2e5),
  ];
}

test("humanReport names what moved when it is given a trend, and is untouched without one", () => {
  const records = movedRecords();
  const trend = analyzeTrend(records, { days: 2, now: new Date("2026-08-01T14:00:00Z") });
  const labels = { 112233445566: "Payments API" };
  const report = buildReport(records);
  const lines = humanReport(report, labels, trend).split("\n");
  const head = lines.findIndex((row) => row.startsWith("What changed:"));

  // Directly under the run rate: "spend rose" and "here is what rose" are one
  // reading, and the block states the two windows it compared.
  assert.ok(lines[head - 1].startsWith("Run rate:"));
  assert.equal(lines[head], "What changed: last 2 days vs previous 2 · $22.50 → $49.00 (117.8%)");
  // Two a side, largest absolute move first, each delta carrying its direction.
  // The opus row moved $0.50 and takes no slot from a row that moved $30.
  assert.deepEqual(lines.slice(head + 1, head + 6), [
    "  model    claude-sonnet-4-6            +$30.00",
    "  model    claude-haiku-4-5             -$4.00",
    "  project  p1                           +$30.00",
    "  project  Payments API (112233445566)  -$4.00",
    "  Where the money moved between those windows, not why it moved; compare tagged, matched task windows before attributing it to a change.",
  ]);
  assert.ok(!lines.some((row) => row.includes("claude-opus-4-5") && row.startsWith("  model")));
  assert.ok(lines[head + 6].startsWith("Tokens:"));

  // The trend is optional in both directions: the two-argument call is the same
  // report it always was, and passing null explicitly is identical to omitting it.
  const bare = humanReport(report, labels);
  assert.ok(!bare.includes("What changed:"));
  assert.equal(bare, humanReport(report, labels, null));
  assert.equal(bare, humanReport(report, labels, undefined));
  // Every other line is untouched; the block is the only difference.
  assert.deepEqual(lines.filter((row) => !row.startsWith("What changed:") && !row.startsWith("  model ") && !row.startsWith("  project ") && !row.startsWith("  Where the money moved")), bare.split("\n"));

  // An unlabelled project keeps its own id, and a caller with no labels file at
  // all still gets the block.
  assert.match(humanReport(report, {}, trend), /\n {2}project {2}112233445566 {17}-\$4\.00\n/);
});

test("a trend with nothing to compare prints no what-changed block at all", () => {
  const now = new Date("2026-08-01T14:00:00Z");
  const report = buildReport(movedRecords());
  // A heading over an empty list is worse than silence: the terminal report is
  // read top to bottom, and there is no section to leave standing.
  assert.ok(!humanReport(report, {}, analyzeTrend([], { days: 2, now })).includes("What changed:"));
  // One window of history and nothing before it: everything is a new arrival, so
  // the deltas are real and the percentage has no base to be a share of.
  const arriving = analyzeTrend([record({ timestamp: "2026-07-30T10:00:00Z", usage: { input: 0, cacheCreate: 0, cacheRead: 0, output: 1e6 } })], { days: 2, now });
  const line = humanReport(report, {}, arriving).split("\n").find((row) => row.startsWith("What changed:"));
  assert.equal(line, "What changed: last 2 days vs previous 2 · $0.00 → $15.00 (n/a)");
});

test("humanReport ranks projects and says once how an id gets a name", () => {
  const turn = (id, project) => record({ messageId: id, requestId: id, project, usage: { input: 0, cacheCreate: 0, cacheRead: 0, output: 1e6 } });
  const report = buildReport([turn("m1", "112233445566"), turn("m2", "112233445566"), turn("m3", "667788990011")]);
  const labelled = humanReport(report, { 112233445566: "Payments API" });
  const lines = labelled.split("\n");

  // Between the models and the sessions: the "where" dimension, in the same
  // column style as the rest of the report.
  assert.ok(lines.indexOf("By model:") < lines.indexOf("By project:"));
  assert.ok(lines.indexOf("By project:") < lines.indexOf("Top anonymous sessions:"));
  assert.ok(lines.includes("  Payments API (112233445566)      $30.00     2,000,000 tokens  2 turns"));
  // An id nobody has named prints as itself rather than as a blank.
  assert.ok(lines.includes("  667788990011                     $15.00     1,000,000 tokens  1 turns"));
  // The note belongs to the section that shows ids, and is printed once even
  // though session rows carry a project too.
  assert.equal(labelled.split("agent-finops label PROJECT_ID").length - 1, 1);
  assert.match(labelled, /Project paths are never stored or printed\./);

  // No labels at all is the backward-compatible default, and the same report.
  const bare = humanReport(report);
  assert.ok(!bare.includes("Payments API"));
  assert.ok(bare.split("\n").includes("  112233445566                     $30.00     2,000,000 tokens  2 turns"));
  assert.equal(bare.split("\n").length, labelled.split("\n").length);

  // A report with no projects at all skips the section rather than heading an
  // empty list; the note goes with it.
  const legacy = humanReport({ ...report, topProjects: [] });
  assert.ok(!legacy.includes("By project:"));
  assert.ok(!legacy.includes("agent-finops label PROJECT_ID"));
});

test("a session row carries the project it ran under and the context it hauls per turn", () => {
  const turn = (id, source, project, cacheRead) => record({ messageId: id, requestId: id, source, project, usage: { input: 0, cacheCreate: 0, cacheRead, output: 1e6 } });
  const report = buildReport([
    turn("m1", "aabbccddeeff", "112233445566", 300_000),
    turn("m2", "aabbccddeeff", "112233445566", 300_000),
    turn("m3", "ffeeddccbbaa", "667788990011", 12_000),
    turn("m4", "0011aabb2233", null, 900),
  ]);
  const labels = { 112233445566: "Payments API" };
  for (const rendered of [humanReport(report, labels), humanSessions(report.topSessions, labels)]) {
    const lines = rendered.split("\n");
    // The diagnosis, not just the number: this session is expensive and it is
    // hauling a 300K context into every turn of one named project.
    assert.ok(lines.includes("  aabbccddeeff      $30.18       2,600,000 tokens  2 turns  300K ctx/turn  project Payments API"));
    // An unlabelled project is shortened on a session row: the row is about the
    // session, and `projects` is where the full fingerprint is printed.
    assert.ok(lines.includes("  ffeeddccbbaa      $15.00       1,012,000 tokens  1 turns  12K ctx/turn  project 667788"));
    // A record with no project id leaves the session unattributed rather than
    // inventing a project for it.
    assert.ok(lines.includes("  0011aabb2233      $15.00       1,000,900 tokens  1 turns  900 ctx/turn  unattributed"));
  }

  // Both renderers take the label map as an optional second argument, so a
  // caller that has no labels file passes nothing and still gets every column.
  for (const rendered of [humanReport(report), humanSessions(report.topSessions)]) {
    assert.ok(!rendered.includes("Payments API"));
    assert.ok(rendered.split("\n").includes("  aabbccddeeff      $30.18       2,600,000 tokens  2 turns  300K ctx/turn  project 112233"));
  }
  assert.equal(humanSessions([]), "No sessions found in this period.");
  assert.match(humanSessions(report.topSessions), /compare-sessions A B/);
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
  // With no per-class dollars there is nothing to weigh the cache bill against,
  // so the token share is the only reading available and is always printed.
  // Only its severity moves.
  assert.deepEqual(kinds(analyzable({ insights: { outputCostShare: null, cacheReadShare: 0.79 } })), ["cache-efficiency:medium"]);
  assert.deepEqual(kinds(analyzable({ insights: { outputCostShare: null, cacheReadShare: 0.8 } })), ["cache-efficiency:info"]);
  assert.match(humanHotspots(hotspotAnalysis(analyzable({ insights: { outputCostShare: null, cacheReadShare: 0.9 } }))), /net positive on tokens/);
});

// The cache question worth asking is which TTL the write was bought at, not what
// the reads would have cost uncached: a read is a tenth of the input rate and an
// agent re-reads its context every turn, so that comparison is favourable in
// every window and says nothing about any particular one.
function cacheReport({ cacheWrite, cacheWrite1h, totalUsd = 100, cacheRead = 0, cacheReadShare = 0.5 }) {
  return analyzable({
    total: { usd: totalUsd, usdByClass: { input: 0, cacheWrite, cacheWrite1h, cacheWrite5m: cacheWrite - cacheWrite1h, cacheRead, output: 0 } },
    insights: { outputCostShare: null, cacheReadShare, cacheWrite1hShare: cacheWrite ? cacheWrite1h / cacheWrite : null },
  });
}

test("cache-ttl states the TTL tradeoff and prices only the 1-hour premium", () => {
  // $40 of $50 in cache writes bought at the 1-hour rate; the same tokens at the
  // 5-minute rate would be 1 - 1.25/2 = 37.5% less, so $15.
  const finding = hotspotAnalysis(cacheReport({ cacheWrite: 50, cacheWrite1h: 40 })).recommendations[0];
  assert.equal(finding.kind, "cache-ttl");
  assert.ok(Math.abs(finding.estimatedSavingsUsd - 15) < 1e-9);
  assert.match(finding.evidence, /Cache writes are 50\.0% of estimated spend \(\$50\.00\), of which 80\.0% \(\$40\.00\) was bought at the 1-hour rate \(2x input\) rather than the 5-minute rate \(1\.25x\)/);
  assert.match(finding.evidence, /would be \$15\.00 less — an upper bound/);
  // Both directions, because this is a genuine tradeoff and not a defect: the
  // action must not read as "turn the 1-hour writes off".
  assert.match(finding.action, /tradeoff, not a defect/);
  assert.match(finding.action, /1-hour TTL costs 60% more per write/);
  assert.match(finding.action, /re-written in full, and one re-write costs more than the premium it saved/);
  assert.match(finding.action, /session cadence/);

  // Severity is the size of the cache bill, not the size of the premium: above
  // 35% of spend it is worth acting on, at or below it is worth understanding.
  assert.equal(finding.severity, "medium", "cache writes are 50% of spend here");
  assert.equal(hotspotAnalysis(cacheReport({ cacheWrite: 35, cacheWrite1h: 30 })).recommendations[0].severity, "info");
  assert.equal(hotspotAnalysis(cacheReport({ cacheWrite: 36, cacheWrite1h: 30 })).recommendations[0].severity, "medium");

  // Non-triggers: a premium too small to be money, and a write bill that is
  // mostly 5-minute writes already.
  assert.deepEqual(kinds(cacheReport({ cacheWrite: 50, cacheWrite1h: 9.99, cacheReadShare: null })), []);
  assert.deepEqual(kinds(cacheReport({ cacheWrite: 70, cacheWrite1h: 34.99, cacheReadShare: null })), []);
  assert.deepEqual(kinds(cacheReport({ cacheWrite: 70, cacheWrite1h: 35, cacheReadShare: null })), ["cache-ttl:medium"]);
});

test("the always-positive uncached-read counterfactual is gone from every cache finding", () => {
  // It was the verdict of every agent workload — writes always look cheap beside
  // ten times the read bill — so it ranked nothing and decided nothing.
  const reports = [
    cacheReport({ cacheWrite: 50, cacheWrite1h: 40, cacheRead: 500 }),
    cacheReport({ cacheWrite: 90, cacheWrite1h: 5, cacheRead: 500, cacheReadShare: 0.95 }),
    analyzable({ insights: { outputCostShare: null, cacheReadShare: 0.9 } }),
  ];
  for (const report of reports) {
    const rendered = JSON.stringify(hotspotAnalysis(report).recommendations);
    assert.ok(!rendered.includes("against uncached reads"), "the uncached-read counterfactual survived");
    assert.ok(!rendered.includes("saved on reads"), "the uncached-read counterfactual survived");
    assert.ok(!/"kind":"cache"/.test(rendered), "the old undifferentiated cache kind survived");
  }
});

test("cache-efficiency is the fallback only when the TTL split cannot speak", () => {
  // Mostly 5-minute writes, but the cache bill is still most of the spend: the
  // token share is the reading that remains, and it carries no savings figure
  // because a read share is not a counterfactual.
  const fallback = hotspotAnalysis(cacheReport({ cacheWrite: 90, cacheWrite1h: 5, cacheReadShare: 0.95 })).recommendations[0];
  assert.equal(fallback.kind, "cache-efficiency");
  assert.equal(fallback.severity, "info");
  assert.equal(fallback.estimatedSavingsUsd, null);
  assert.match(fallback.evidence, /Cache reads are 95\.0% of prompt tokens/);

  // Below a large share of spend the cache bill is not what this window is about,
  // and a reading nobody can act on is noise.
  assert.deepEqual(kinds(cacheReport({ cacheWrite: 34.99, cacheWrite1h: 0, cacheReadShare: 0.95 })), []);
  assert.deepEqual(kinds(cacheReport({ cacheWrite: 35, cacheWrite1h: 0, cacheReadShare: 0.95 })), ["cache-efficiency:info"]);
  // Nothing priced: there are no dollars to take a share of, so the token share
  // is printed on its own rather than suppressed.
  assert.deepEqual(kinds(cacheReport({ cacheWrite: 0, cacheWrite1h: 0, totalUsd: 0, cacheReadShare: 0.5 })), ["cache-efficiency:medium"]);
  // The TTL finding wins outright when it fires; the two never both appear.
  assert.deepEqual(kinds(cacheReport({ cacheWrite: 50, cacheWrite1h: 40, cacheReadShare: 0.95 })), ["cache-ttl:medium"]);
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

  // The same difference is what the finding is ranked by, so the number in the
  // sentence and the number in the field are one calculation, not two.
  assert.equal(finding.estimatedSavingsUsd, 10);
  assert.ok(Math.abs(repriced.estimatedSavingsUsd - (opusUsd - sonnetUsd)) < 1e-9);

  // Haiku is the bottom of the ladder, so the share is still reported and the
  // counterfactual is simply absent rather than invented.
  const haiku = hotspotAnalysis(analyzable({ total: { usd: 25 }, byModel: { "claude-haiku-4-5": { usd: 25, usage } } })).recommendations[0];
  assert.equal(haiku.kind, "model-concentration");
  assert.ok(!haiku.evidence.includes("Re-pricing"));
  assert.equal(haiku.estimatedSavingsUsd, null, "no sibling means no defensible saving, not a saving of zero");
  // An aggregate with no token counts cannot be re-priced at all.
  const noTokens = hotspotAnalysis(analyzable({ total: { usd: 25 }, byModel: { "claude-opus-5": { usd: 25 } } })).recommendations[0];
  assert.ok(!noTokens.evidence.includes("Re-pricing"));
  assert.equal(noTokens.estimatedSavingsUsd, null);
});

test("context bloat names one session, and only when the context is both large and expensive", () => {
  const session = (id, avgPromptTokens, usd, requests = 40) => ({ id, avgPromptTokens, usd, requests });
  assert.deepEqual(kinds(analyzable({ topSessions: [session("aabbccddeeff", 149_999, 9)] })), []);
  assert.deepEqual(kinds(analyzable({ topSessions: [session("aabbccddeeff", 150_000, 4.99)] })), []);

  // Severity is the session's share of the window, not its absolute cost. Above
  // $10 the session-outlier rule would also fire on this row; it is suppressed,
  // because two findings naming one session read as two problems.
  assert.deepEqual(kinds(analyzable({ topSessions: [session("aabbccddeeff", 150_000, 19.99)] })), ["context-bloat:medium"]);
  assert.deepEqual(kinds(analyzable({ topSessions: [session("aabbccddeeff", 150_000, 5)] })), ["context-bloat:medium"]);
  const worst = hotspotAnalysis(analyzable({ topSessions: [session("aabbccddeeff", 210_000, 61, 42), session("ffeeddccbbaa", 300_000, 30)] }));
  assert.deepEqual(worst.recommendations.map((item) => `${item.kind}:${item.severity}`), ["context-bloat:high"]);
  // One row, for the costliest offender, however many sessions qualify.
  assert.equal(worst.recommendations.filter((item) => item.kind === "context-bloat").length, 1);
  const bloat = worst.recommendations[0];
  // No per-class dollars on this bucket, so no counterfactual is invented.
  assert.equal(bloat.estimatedSavingsUsd, null);
  assert.equal(bloat.evidence, "Session aabbccddeeff averaged 210K prompt tokens per turn across 42 turn(s) (≈$61.00).");
  assert.match(bloat.action, /compact earlier/);
});

test("context bloat prices a capped context by scaling the session's cache reads", () => {
  // Cache reads are the context re-billed every turn, so a prompt held to half
  // its size re-bills half of them: $24 of reads at 300K average against a 150K
  // target is $12.
  const bloated = (avgPromptTokens, cacheRead) => analyzable({
    topSessions: [{ id: "aabbccddeeff", avgPromptTokens, usd: 40, requests: 20, usdByClass: { input: 4, cacheWrite: 6, cacheWrite1h: 0, cacheWrite5m: 6, cacheRead, output: 6 } }],
  });
  const half = hotspotAnalysis(bloated(300_000, 24)).recommendations[0];
  assert.equal(half.kind, "context-bloat");
  assert.ok(Math.abs(half.estimatedSavingsUsd - 12) < 1e-9);
  assert.match(half.evidence, /Holding the average prompt to 150K would re-bill its cache reads in proportion, ≈\$12\.00 less/);
  // Stated as a ceiling: the same work has to fit in the smaller context for it.
  assert.match(half.evidence, /an upper bound that assumes the same work fits in the smaller context/);

  // Only the excess over the target is claimed, never the whole read bill.
  const quarter = hotspotAnalysis(bloated(200_000, 24)).recommendations[0];
  assert.ok(Math.abs(quarter.estimatedSavingsUsd - 6) < 1e-9);
  // Exactly at the target there is nothing to cut, and the figure is 0 rather
  // than a negative saving.
  assert.equal(hotspotAnalysis(bloated(150_000, 24)).recommendations[0].estimatedSavingsUsd, 0);
  // A session with no cache reads carries no priced context to shrink.
  assert.equal(hotspotAnalysis(bloated(300_000, 0)).recommendations[0].estimatedSavingsUsd, 0);

  // A tag snapshot taken before per-class dollars existed cannot be scaled, and
  // guessing which part of its estimate was cache reads would invent the number
  // the finding is ranked by. The finding still fires, unquantified.
  const legacy = hotspotAnalysis(analyzable({ topSessions: [{ id: "aabbccddeeff", avgPromptTokens: 300_000, usd: 40, requests: 20 }] })).recommendations[0];
  assert.equal(legacy.kind, "context-bloat");
  assert.equal(legacy.estimatedSavingsUsd, null);
  assert.ok(!legacy.evidence.includes("Holding the average prompt"));
});

test("session-outlier fires only for an expensive session context bloat has not already claimed", () => {
  // Heavy per-turn context: context-bloat is the more specific diagnosis and the
  // only one raised, so the two rules never point at one session twice.
  const heavy = analyzable({ topSessions: [{ id: "aabbccddeeff", usd: 30, requests: 12, avgPromptTokens: 400_000 }] });
  assert.deepEqual(kinds(heavy), ["context-bloat:high"]);

  // Normal per-turn context and the same money: a different diagnosis entirely —
  // many turns rather than heavy ones — and the evidence has to say which.
  const many = hotspotAnalysis(analyzable({ topSessions: [{ id: "aabbccddeeff", usd: 30, requests: 240, avgPromptTokens: 42_500 }] })).recommendations[0];
  assert.equal(many.kind, "session-outlier");
  assert.equal(many.estimatedSavingsUsd, null);
  assert.match(many.evidence, /cost \$30\.00 across 240 turn\(s\), averaging 42,500 prompt tokens per turn/);
  assert.match(many.evidence, /under the 150K context-bloat threshold, so this session is expensive for how many turns it ran rather than how heavy each one was/);
  assert.match(many.action, /turn count and workflow/);

  // Both can still appear, on different sessions: the top session is expensive
  // for its turn count and a cheaper one below it is expensive for its context.
  assert.deepEqual(kinds(analyzable({
    topSessions: [
      { id: "aabbccddeeff", usd: 30, requests: 240, avgPromptTokens: 42_500 },
      { id: "ffeeddccbbaa", usd: 12, requests: 6, avgPromptTokens: 400_000 },
    ],
  })), ["session-outlier:medium", "context-bloat:medium"]);
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
  // Nothing was measured, so the finding is an unquantified nudge rather than a
  // saving of zero — and it ranks below anything that carries a figure.
  assert.equal(bare.estimatedSavingsUsd, null);

  const measured = hotspotAnalysis(withBash(40), { filterStats: { events: 9, rawChars: 500_000, sentChars: 100_000, savedChars: 400_000, estimatedTokensSaved: 100_000 } }).recommendations[0];
  assert.match(measured.evidence, /already removed ~100,000 input tokens across 9 filtered result\(s\)/);
  // A ledger that exists but has removed nothing has nothing to report.
  const empty = hotspotAnalysis(withBash(40), { filterStats: { events: 0, savedChars: 0, estimatedTokensSaved: 0 } }).recommendations[0];
  assert.ok(!empty.evidence.includes("already removed"));
  assert.equal(empty.estimatedSavingsUsd, null);
});

test("filter savings are priced as the cache write those tokens would have been", () => {
  // Removed output never enters the context, so it is priced as a cache write at
  // the window's dominant model rate: 100K tokens at sonnet-4-6's $3/M input,
  // charged at the conservative 5-minute multiplier of 1.25x, is $0.375.
  const stats = { events: 9, rawChars: 500_000, sentChars: 100_000, savedChars: 400_000, estimatedTokensSaved: 100_000 };
  const withModel = (model) => analyzable({
    // Under half the spend, so this fixture raises no model-concentration row.
    byModel: { [model]: { usd: 40 } },
    topTools: [{ name: "Bash", usd: 40, followOnRequests: 12 }],
  });
  const priced = hotspotAnalysis(withModel("claude-sonnet-4-6"), { filterStats: stats }).recommendations[0];
  assert.equal(priced.kind, "bash-output-filter");
  assert.ok(Math.abs(priced.estimatedSavingsUsd - 0.375) < 1e-9);
  assert.match(priced.evidence, /At claude-sonnet-4-6 cache-write rates that is ≈\$0\.38 of context never bought/);

  // A dominant model with no local rate cannot price anything, and the finding
  // reports the tokens removed without inventing a dollar figure for them.
  const unpriced = hotspotAnalysis(withModel("claude-internal-preview"), { filterStats: stats }).recommendations[0];
  assert.equal(unpriced.estimatedSavingsUsd, null);
  assert.match(unpriced.evidence, /already removed ~100,000 input tokens/);
  assert.ok(!unpriced.evidence.includes("cache-write rates"));
  // No model at all in the window is the same answer.
  assert.equal(hotspotAnalysis(analyzable({ topTools: [{ name: "Bash", usd: 40, followOnRequests: 12 }] }), { filterStats: stats }).recommendations[0].estimatedSavingsUsd, null);
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

// A window with five findings across the whole severity range, chosen so that
// the ranking cannot be satisfied by rule order, by severity, or by either one
// alone. Ranking by what acting is worth is the point of the list.
function rankable() {
  return analyzable({
    total: { usd: 100, usdByClass: { input: 0, cacheWrite: 30, cacheWrite1h: 24, cacheWrite5m: 6, cacheRead: 0, output: 0 } },
    // 2.4M output tokens cost $60 on opus-5 and $36 on sonnet-5: a $24 what-if.
    byModel: { "claude-opus-5": { usd: 60, usage: { input: 0, cacheCreate: 0, cacheCreate1h: 0, cacheCreate5m: 0, cacheRead: 0, output: 2.4e6, total: 2.4e6 } } },
    topSessions: [{ id: "aabbccddeeff", usd: 20, requests: 100, avgPromptTokens: 50_000 }],
    topTools: [{ name: "mcp__issues__search", usd: 25, followOnRequests: 5 }],
    insights: { outputCostShare: 0.2, cacheReadShare: null, cacheWrite1hShare: 0.8 },
  });
}

test("recommendations are ranked by estimated savings, with the unquantified ones last", () => {
  const analysis = hotspotAnalysis(rankable());
  assert.deepEqual(analysis.recommendations.map((item) => item.kind), [
    // $24, then $9: dollars decide the top of the list.
    "model-concentration",
    "cache-ttl",
    // Nothing below here has a defensible counterfactual. `mcp-follow-on-cost`
    // is the last rule of the three to run and the first of them to print,
    // because among unquantified findings severity is the tie-break.
    "mcp-follow-on-cost",
    // Then rule order, which is what separates two medium/unquantified rows.
    "output-cost",
    "session-outlier",
  ]);
  assert.deepEqual(analysis.recommendations.map((item) => item.severity), ["high", "info", "high", "medium", "medium"]);
  assert.deepEqual(analysis.recommendations.map((item) => item.estimatedSavingsUsd), [24, 9, null, null, null]);
  // The headline figure sums only what was quantified.
  assert.equal(analysis.totalEstimatedSavingsUsd, 33);
  // Null is "no defensible counterfactual", never zero: it must not be summed
  // in, and it must not sort as if it were the cheapest quantified finding.
  assert.ok(analysis.recommendations.slice(2).every((item) => item.estimatedSavingsUsd === null));
});

test("equal savings are separated by severity, not by the order the rules ran", () => {
  // $32 of 1-hour writes is a $12 premium, and $24 of session cache reads at a
  // 300K average against the 150K target is also $12. The cache rule runs first
  // and is `info`; the context rule runs later and is `high`, so a correct
  // ranking prints them in the opposite order to the rules.
  const analysis = hotspotAnalysis(analyzable({
    total: { usd: 100, usdByClass: { input: 0, cacheWrite: 32, cacheWrite1h: 32, cacheWrite5m: 0, cacheRead: 0, output: 0 } },
    topSessions: [{ id: "aabbccddeeff", usd: 20, requests: 5, avgPromptTokens: 300_000, usdByClass: { input: 0, cacheWrite: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 24, output: 0 } }],
    insights: { outputCostShare: null, cacheReadShare: null, cacheWrite1hShare: 1 },
  }));
  assert.deepEqual(analysis.recommendations.map((item) => `${item.kind}:${item.severity}`), ["context-bloat:high", "cache-ttl:info"]);
  for (const item of analysis.recommendations) assert.ok(Math.abs(item.estimatedSavingsUsd - 12) < 1e-9);
  assert.ok(Math.abs(analysis.totalEstimatedSavingsUsd - 24) < 1e-9);
});

test("humanHotspots leads with the ranking headline and prints each figure inline", () => {
  const rendered = humanHotspots(hotspotAnalysis(rankable()));
  const lines = rendered.split("\n");
  assert.equal(lines[0], "agent-finops hotspots");
  assert.equal(lines[1], "Ranked by estimated upper-bound savings · $33.00 total across 2 quantified findings");
  // Each quantified finding carries its own figure in its heading line; the
  // unquantified ones print exactly as before.
  assert.ok(rendered.includes("[high] model-concentration · up to $24.00"));
  assert.ok(rendered.includes("[info] cache-ttl · up to $9.00"));
  assert.ok(rendered.includes("[high] mcp-follow-on-cost\n"));
  assert.ok(!rendered.includes("mcp-follow-on-cost ·"));
  // The evidence/action structure is unchanged.
  assert.match(rendered, /\n {2}Evidence: claude-opus-5 is 60\.0% of estimated spend\./);
  assert.match(rendered, /\n {2}Next: Run a tagged, comparable task set/);
  // Estimate, never invoice — and a ceiling on this window, not a forecast.
  assert.match(rendered, /a local estimate from list prices, not a bill/);
  assert.match(rendered, /upper bounds on this same workload .* not a forecast/);

  // One quantified finding is a singular headline.
  assert.match(humanHotspots(hotspotAnalysis(analyzable({ total: { usd: 100, usdByClass: { input: 0, cacheWrite: 40, cacheWrite1h: 40, cacheWrite5m: 0, cacheRead: 0, output: 0 } }, insights: { outputCostShare: null, cacheReadShare: null } }))), /\$15\.00 total across 1 quantified finding\n/);
});

test("humanHotspots omits the headline when nothing in the window can be quantified", () => {
  const analysis = hotspotAnalysis(analyzable({
    topSessions: [{ id: "aabbccddeeff", usd: 30, requests: 240, avgPromptTokens: 42_500 }],
    insights: { outputCostShare: 0.2, cacheReadShare: null },
  }));
  assert.equal(analysis.totalEstimatedSavingsUsd, 0);
  const lines = humanHotspots(analysis).split("\n");
  assert.equal(lines[0], "agent-finops hotspots");
  // Straight into the findings: a "$0.00 total" headline would read as a verdict
  // that there is nothing to save, rather than nothing this tool can price.
  assert.equal(lines[1], "");
  assert.equal(lines[2], "[medium] output-cost");
  assert.ok(!lines.some((line) => line.startsWith("Ranked by")));
  assert.ok(!lines.some((line) => line.includes("up to $")));
});
