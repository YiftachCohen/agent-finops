import test from "node:test";
import assert from "node:assert/strict";
import { buildReport, humanReport } from "../src/report.mjs";

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

test("date filtering excludes records outside the requested interval", () => {
  const report = buildReport([record({ timestamp: "2026-07-01T10:00:00Z" }), record({ messageId: "m2", requestId: "r2", timestamp: "2026-08-01T10:00:00Z" })], { sinceMs: Date.parse("2026-08-01T00:00:00Z") });
  assert.equal(report.total.requests, 1);
  assert.equal(report.scope.recordsAfterDateFilter, 1);
});
