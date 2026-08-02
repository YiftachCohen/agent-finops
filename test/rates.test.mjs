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
