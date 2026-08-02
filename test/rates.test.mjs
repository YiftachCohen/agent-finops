import test from "node:test";
import assert from "node:assert/strict";
import { canonicalModelId, costFor, rateFor } from "../src/rates.mjs";

test("normalizes Bedrock, dated, and long-context model ids to one rate key", () => {
  assert.equal(canonicalModelId("us.anthropic.claude-sonnet-4-5-20250929-v1:0"), "claude-sonnet-4-5");
  assert.equal(canonicalModelId("claude-opus-5[1m]"), "claude-opus-5");
  assert.equal(canonicalModelId("claude-3-5-haiku-20241022"), "claude-3-5-haiku");
  // The 1M marker is a routing detail, not a price tier: current models serve
  // their full context window at standard rates.
  assert.deepEqual(rateFor("claude-opus-5[1m]"), rateFor("claude-opus-5"));
});

test("a model id naming a prototype property resolves to no rate", () => {
  // `RATES[id]` takes its key from a log file. On a prototyped table
  // `rateFor("__proto__")` handed back Object.prototype and it was priced.
  assert.equal(rateFor("__proto__"), null);
  assert.equal(rateFor("constructor"), null);
  assert.equal(rateFor("toString"), null);
  assert.equal(costFor({ model: "__proto__", usage: { input: 1, cacheCreate: 0, cacheRead: 0, output: 1 } }).priced, false);
});

test("introductory pricing applies by billing timestamp, not by report time", () => {
  assert.deepEqual(rateFor("claude-sonnet-5", "2026-08-02T00:00:00Z"), { input: 2, output: 10 });
  assert.deepEqual(rateFor("claude-sonnet-5", "2026-09-01T00:00:00Z"), { input: 3, output: 15 });
  // An unplaceable record must never lower the estimate.
  assert.deepEqual(rateFor("claude-sonnet-5", null), { input: 3, output: 15 });
});

test("prices each cache class separately and never invents a rate", () => {
  const cost = costFor({
    model: "claude-opus-5",
    timestamp: "2026-08-01T10:00:00Z",
    usage: { input: 1e6, cacheCreate: 1e6, cacheRead: 1e6, output: 1e6 },
  });
  // 5 input + 6.25 cache write + 0.5 cache read + 25 output
  assert.ok(Math.abs(cost.usd - 36.75) < 1e-9);
  assert.ok(Math.abs(cost.outputUsd - 25) < 1e-9);
  assert.deepEqual(costFor({ model: "claude-unreleased-9", usage: { input: 1, cacheCreate: 0, cacheRead: 0, output: 1 } }), { usd: 0, priced: false });
});

test("prices cache writes by TTL: a 1-hour write costs 2x input, a 5-minute write 1.25x", () => {
  const base = { model: "claude-opus-5", timestamp: "2026-08-01T10:00:00Z" };
  const oneHour = costFor({ ...base, usage: { input: 0, cacheCreate: 1e6, cacheCreate1h: 1e6, cacheCreate5m: 0, cacheRead: 0, output: 0 } });
  const fiveMinute = costFor({ ...base, usage: { input: 0, cacheCreate: 1e6, cacheCreate1h: 0, cacheCreate5m: 1e6, cacheRead: 0, output: 0 } });
  // Opus 5 input is $5/MTok: 1M tokens at 2x is $10, at 1.25x is $6.25.
  assert.ok(Math.abs(oneHour.usd - 10) < 1e-9);
  assert.ok(Math.abs(fiveMinute.usd - 6.25) < 1e-9);

  const mixed = costFor({ ...base, usage: { input: 0, cacheCreate: 1e6, cacheCreate1h: 6e5, cacheCreate5m: 4e5, cacheRead: 0, output: 0 } });
  assert.ok(Math.abs(mixed.usd - (6e5 * 2 + 4e5 * 1.25) * 5 / 1e6) < 1e-9);
});

test("per-class dollars account for the whole estimate at each class's own rate", () => {
  const cost = costFor({
    model: "claude-opus-5",
    timestamp: "2026-08-01T10:00:00Z",
    usage: { input: 1e6, cacheCreate: 1e6, cacheCreate1h: 6e5, cacheCreate5m: 4e5, cacheRead: 1e6, output: 1e6 },
  });
  const c = cost.usdByClass;
  // Opus 5: input $5/MTok, output $25/MTok.
  assert.ok(Math.abs(c.input - 5) < 1e-9);
  assert.ok(Math.abs(c.cacheWrite1h - 6e5 * 2 * 5 / 1e6) < 1e-9);
  assert.ok(Math.abs(c.cacheWrite5m - 4e5 * 1.25 * 5 / 1e6) < 1e-9);
  assert.ok(Math.abs(c.cacheWrite - (c.cacheWrite1h + c.cacheWrite5m)) < 1e-9);
  assert.ok(Math.abs(c.cacheRead - 0.5) < 1e-9, "a cache read is 0.1x the input rate");
  assert.ok(Math.abs(c.output - 25) < 1e-9);
  assert.equal(c.output, cost.outputUsd);
  // The four charged classes are the whole bill; the TTL rows only break
  // `cacheWrite` down and must not be summed alongside it.
  assert.ok(Math.abs(c.input + c.cacheWrite + c.cacheRead + c.output - cost.usd) < 1e-9);
});

test("unclassified cache-write dollars land in the total but not in either TTL row", () => {
  const cost = costFor({
    model: "claude-opus-5",
    timestamp: "2026-08-01T10:00:00Z",
    usage: { input: 0, cacheCreate: 1e6, cacheCreate1h: 8e5, cacheCreate5m: 0, cacheRead: 0, output: 0 },
  });
  const c = cost.usdByClass;
  assert.ok(Math.abs(c.cacheWrite - (8e5 * 2 + 2e5 * 1.25) * 5 / 1e6) < 1e-9);
  assert.ok(Math.abs(c.cacheWrite1h - 8e5 * 2 * 5 / 1e6) < 1e-9);
  assert.equal(c.cacheWrite5m, 0);
  // The remainder is the visible gap between the total and its breakdown.
  assert.ok(Math.abs(c.cacheWrite - c.cacheWrite1h - c.cacheWrite5m - 2e5 * 1.25 * 5 / 1e6) < 1e-9);
  assert.ok(Math.abs(c.input + c.cacheWrite + c.cacheRead + c.output - cost.usd) < 1e-9);

  // A turn logged before the TTL split existed has a total with no breakdown.
  const legacy = costFor({ model: "claude-opus-5", timestamp: "2026-08-01T10:00:00Z", usage: { input: 0, cacheCreate: 1e6, cacheRead: 0, output: 0 } });
  assert.ok(Math.abs(legacy.usdByClass.cacheWrite - 6.25) < 1e-9);
  assert.equal(legacy.usdByClass.cacheWrite1h, 0);
  assert.equal(legacy.usdByClass.cacheWrite5m, 0);
});

test("a cache write with no recorded TTL is charged at the 5-minute floor", () => {
  // Turns logged before Claude Code broke the total down by TTL carry only
  // `cacheCreate`. Charging them at the 1-hour rate would overstate the bill.
  const legacy = costFor({ model: "claude-opus-5", timestamp: "2026-08-01T10:00:00Z", usage: { input: 0, cacheCreate: 1e6, cacheRead: 0, output: 0 } });
  assert.ok(Math.abs(legacy.usd - 6.25) < 1e-9);

  // A partially classified turn charges only the unclassified remainder at 5m.
  const partial = costFor({ model: "claude-opus-5", timestamp: "2026-08-01T10:00:00Z", usage: { input: 0, cacheCreate: 1e6, cacheCreate1h: 1e6 - 2e5, cacheCreate5m: 0, cacheRead: 0, output: 0 } });
  assert.ok(Math.abs(partial.usd - (8e5 * 2 + 2e5 * 1.25) * 5 / 1e6) < 1e-9);
});
