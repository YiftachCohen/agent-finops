// Local list-price estimates in USD per million tokens. No runtime lookup.
//
// `promotion` is an introductory price that applies to usage timestamped before
// `until`. It is stored alongside the list price rather than replacing it so a
// report spanning the changeover prices each turn with the rate that was in
// effect when the turn was billed.

const RATES = {
  "claude-fable-5": { input: 10, output: 50 },
  "claude-mythos-5": { input: 10, output: 50 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-opus-4-5": { input: 5, output: 25 },
  "claude-opus-4-1": { input: 15, output: 75 },
  "claude-opus-4": { input: 15, output: 75 },
  "claude-sonnet-5": { input: 3, output: 15, promotion: { until: "2026-09-01T00:00:00Z", input: 2, output: 10 } },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-sonnet-4": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-3-5-haiku": { input: 0.8, output: 4 },
  "claude-3-haiku": { input: 0.25, output: 1.25 },
};

const ALIASES = { opus: "claude-opus-5", sonnet: "claude-sonnet-5", haiku: "claude-haiku-4-5" };

// Cache writes are priced against the 5-minute TTL. A 1-hour TTL costs 2x input
// instead, and the JSONL does not record which TTL a turn used.
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

export function canonicalModelId(model) {
  if (typeof model !== "string") return "";
  return model
    .toLowerCase()
    // Current models serve their full context window at standard rates, so the
    // 1M marker Claude Code appends is a routing detail, not a price tier.
    .replace(/\[1m]$/, "")
    .replace(/^(us|eu|apac|us-gov)\./, "")
    .replace(/^anthropic\./, "")
    .replace(/-v\d+:\d+$/, "")
    .replace(/-\d{8}$/, "");
}

/** Resolve the rate in effect for a model, optionally at a specific time. */
export function rateFor(model, timestamp = null) {
  const id = canonicalModelId(model);
  const rate = RATES[id] || RATES[ALIASES[id]] || null;
  if (!rate?.promotion) return rate;
  // An unparseable or absent timestamp falls back to the list price so the
  // estimate is never lowered by a record we cannot place in time.
  const billedAt = Date.parse(timestamp || "");
  const promotionEnds = Date.parse(rate.promotion.until);
  if (!Number.isFinite(billedAt) || billedAt >= promotionEnds) return { input: rate.input, output: rate.output };
  return { input: rate.promotion.input, output: rate.promotion.output };
}

export function costFor(record) {
  const rate = rateFor(record.model, record.timestamp);
  if (!rate) return { usd: 0, priced: false };
  const u = record.usage;
  const outputUsd = (u.output * rate.output) / 1e6;
  return {
    usd: (u.input * rate.input + u.cacheCreate * rate.input * CACHE_WRITE_MULTIPLIER + u.cacheRead * rate.input * CACHE_READ_MULTIPLIER) / 1e6 + outputUsd,
    outputUsd,
    priced: true,
  };
}
