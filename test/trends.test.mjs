import test from "node:test";
import assert from "node:assert/strict";
import { analyzeTrend, humanTrend } from "../src/trends.mjs";

function record(day, output, overrides = {}) {
  return {
    source: "session",
    project: "project",
    messageId: `${day}-${output}-${overrides.model || ""}-${overrides.project || ""}`,
    requestId: `${day}-${output}-${overrides.model || ""}-${overrides.project || ""}`,
    model: "claude-sonnet-4-6",
    timestamp: `${day}T12:00:00Z`,
    usage: { input: 0, cacheCreate: 0, cacheRead: 0, output },
    ...overrides,
  };
}

test("trend compares equal calendar windows and exposes daily history", () => {
  const records = [record("2026-07-28", 50), record("2026-07-29", 100), record("2026-07-30", 100), record("2026-07-31", 200), record("2026-08-01", 200)];
  const trend = analyzeTrend(records, { days: 2, now: new Date("2026-08-01T14:00:00Z") });
  // Both windows hold whole days only: current is 07-30..07-31, previous is
  // 07-28..07-29. Today would otherwise contribute 14 hours to a 2-day window
  // and make the period read as a decline every morning.
  assert.equal(trend.previous.report.total.usage.output, 150);
  assert.equal(trend.current.report.total.usage.output, 300);
  assert.ok(trend.deltaUsd > 0);
  assert.deepEqual(Object.keys(trend.current.report.byDay), ["2026-07-30", "2026-07-31"]);
  assert.deepEqual([trend.current.start, trend.current.end], ["2026-07-30", "2026-07-31"]);
  assert.deepEqual([trend.previous.start, trend.previous.end], ["2026-07-28", "2026-07-29"]);
});

test("trend attributes its delta to the models and projects that moved", () => {
  // Sonnet 4.6 bills output at $15/M and Haiku 4.5 at $5/M, so these windows are
  // $20 previous and $46 current.
  const records = [
    record("2026-07-28", 1e6, { model: "claude-sonnet-4-6", project: "p1" }),
    record("2026-07-28", 1e6, { model: "claude-haiku-4-5", project: "p2" }),
    record("2026-07-28", 1e5, { model: "claude-opus-4-5", project: "p3" }),
    record("2026-07-30", 3e6, { model: "claude-sonnet-4-6", project: "p1" }),
    record("2026-07-30", 2e5, { model: "claude-haiku-4-5", project: "p2" }),
    record("2026-07-30", 1e5, { model: "claude-opus-4-5", project: "p3" }),
  ];
  const trend = analyzeTrend(records, { days: 2, now: new Date("2026-08-01T14:00:00Z") });
  assert.deepEqual(trend.drivers.byModel, [
    { model: "claude-sonnet-4-6", deltaUsd: 30 },
    { model: "claude-haiku-4-5", deltaUsd: -4 },
  ]);
  // The opus row is identical in both windows, so it is not a driver of
  // anything and does not take a slot from one that is.
  assert.deepEqual(trend.drivers.byProject, [{ id: "p1", deltaUsd: 30 }, { id: "p2", deltaUsd: -4 }]);

  const text = humanTrend(trend);
  assert.match(text, /Largest drivers:/);
  assert.match(text, /model {4}claude-sonnet-4-6 +\$30\.00/);
  assert.match(text, /project {2}p1 +\$30\.00/);
  // Descriptive, never causal: the footer still says so.
  assert.match(text, /not proof that a configuration change caused it/);
});

test("driver lists are capped, and a window with no history has no drivers to name", () => {
  const many = [];
  for (let i = 0; i < 7; i++) many.push(record("2026-07-30", (i + 1) * 1e5, { model: "claude-sonnet-4-6", project: `p${i}` }));
  const trend = analyzeTrend(many, { days: 2, now: new Date("2026-08-01T14:00:00Z") });
  assert.equal(trend.drivers.byProject.length, 5, "top five each, largest absolute change first");
  assert.deepEqual(trend.drivers.byProject.map((row) => row.id), ["p6", "p5", "p4", "p3", "p2"]);
  assert.deepEqual(trend.drivers.byModel.map((row) => row.model), ["claude-sonnet-4-6"]);

  const empty = analyzeTrend([], { days: 2, now: new Date("2026-08-01T14:00:00Z") });
  assert.deepEqual(empty.drivers, { byModel: [], byProject: [] });
  assert.ok(!humanTrend(empty).includes("Largest drivers:"));
});

test("today's partial spend is reported beside the comparison, never inside it", () => {
  const records = [record("2026-07-30", 100), record("2026-07-31", 200), record("2026-08-01", 400)];
  const trend = analyzeTrend(records, { days: 2, now: new Date("2026-08-01T14:00:00Z") });
  assert.equal(trend.today.day, "2026-08-01");
  assert.equal(trend.today.partial, true);
  assert.equal(trend.today.report.total.usage.output, 400);
  assert.equal(trend.current.report.total.usage.output, 300, "today stays out of the compared window");
  assert.match(humanTrend(trend), /Today 2026-08-01 \(partial\)/);
});
