import test from "node:test";
import assert from "node:assert/strict";
import { analyzeTrend } from "../src/trends.mjs";

function record(day, output) {
  return { source: "session", project: "project", messageId: `${day}-${output}`, requestId: `${day}-${output}`, model: "claude-sonnet-4-6", timestamp: `${day}T12:00:00Z`, usage: { input: 0, cacheCreate: 0, cacheRead: 0, output } };
}

test("trend compares equal calendar windows and exposes daily history", () => {
  const records = [record("2026-07-29", 100), record("2026-07-30", 100), record("2026-07-31", 200), record("2026-08-01", 200)];
  const trend = analyzeTrend(records, { days: 2, now: new Date("2026-08-01T14:00:00Z") });
  assert.equal(trend.previous.report.total.usage.output, 200);
  assert.equal(trend.current.report.total.usage.output, 400);
  assert.ok(trend.deltaUsd > 0);
  assert.deepEqual(Object.keys(trend.current.report.byDay), ["2026-07-31", "2026-08-01"]);
});
