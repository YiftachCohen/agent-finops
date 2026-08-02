// Local list-price estimates in USD per million tokens. No runtime lookup.
//
// `promotion` is an introductory price that applies to usage timestamped before
// `until`. It is stored alongside the list price rather than replacing it so a
// report spanning the changeover prices each turn with the rate that was in
// effect when the turn was billed.

// Null prototypes: the lookup key is a model id read out of a log file, so a
// value such as `__proto__` or `constructor` must not resolve to an inherited
// property and be mistaken for a rate.
const RATES = {
  __proto__: null,
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

const ALIASES = { __proto__: null, opus: "claude-opus-5", sonnet: "claude-sonnet-5", haiku: "claude-haiku-4-5" };

// Bumped whenever a correction changes what the same usage costs. Snapshots
// record it so a comparison spanning the change can say so instead of
// presenting the correction as a spending change.
// 2: cache writes priced by TTL rather than always at the 5-minute rate.
export const PRICING_VERSION = 2;

// Cache writes are priced by TTL: a 5-minute write costs 1.25x the input rate,
// a 1-hour write 2x. Claude Code records the split under
// `message.usage.cache_creation`, so the TTL is read per turn rather than
// assumed. Turns predating that field carry only the total and are priced at
// the 5-minute rate, which is the conservative floor.
const CACHE_WRITE_5M_MULTIPLIER = 1.25;
const CACHE_WRITE_1H_MULTIPLIER = 2;
const CACHE_READ_MULTIPLIER = 0.1;

/** Split cache-write tokens by TTL, charging any unclassified remainder at 5m. */
export function cacheWriteSplit(usage) {
  const oneHour = usage.cacheCreate1h || 0;
  const fiveMinute = usage.cacheCreate5m || 0;
  const unclassified = Math.max(0, (usage.cacheCreate || 0) - oneHour - fiveMinute);
  return { oneHour, fiveMinute: fiveMinute + unclassified };
}

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

// The next cheaper tier for a counterfactual, chosen by model class rather than
// by scanning the table for the closest price: the question a what-if answers is
// "would a smaller model have done this work?", which is a class question. Haiku
// is the floor and deliberately has no sibling. The targets are the current
// aliases, so this follows the alias table when a new generation lands.
const MODEL_CLASS_RE = /(fable|mythos|opus|sonnet|haiku)/;
const CHEAPER_SIBLING = { __proto__: null, fable: ALIASES.sonnet, mythos: ALIASES.sonnet, opus: ALIASES.sonnet, sonnet: ALIASES.haiku, haiku: null };

/**
 * The cheaper model a what-if should re-price against, or null when there is
 * none — an unpriced model, an unrecognized class, the bottom of the ladder, or
 * a sibling that is not actually cheaper.
 */
export function cheaperSiblingModel(model) {
  const id = canonicalModelId(model);
  const rate = rateFor(id);
  if (!rate) return null;
  const sibling = CHEAPER_SIBLING[MODEL_CLASS_RE.exec(id)?.[1]] || null;
  const siblingRate = sibling ? rateFor(sibling) : null;
  if (!siblingRate || siblingRate.input >= rate.input) return null;
  return sibling;
}

/**
 * Price an aggregate token usage at a named model's rate, or null when that
 * model has no local rate. `costFor` is one call to this, which is what keeps a
 * counterfactual on exactly the same TTL multipliers as the real estimate
 * instead of a second copy of the multiplier math elsewhere. A null timestamp
 * prices at list price rather than at a promotion, so a what-if is never made
 * to look cheaper by a promotion the window may not have been billed under.
 */
export function priceUsage(usage, model, timestamp = null) {
  const rate = rateFor(model, timestamp);
  if (!rate) return null;
  const u = usage || {};
  const outputUsd = ((u.output || 0) * rate.output) / 1e6;
  const write = cacheWriteSplit(u);
  const cacheWriteTokens = write.oneHour * CACHE_WRITE_1H_MULTIPLIER + write.fiveMinute * CACHE_WRITE_5M_MULTIPLIER;
  const inputUsd = ((u.input || 0) * rate.input) / 1e6;
  const cacheWriteUsd = (cacheWriteTokens * rate.input) / 1e6;
  const cacheReadUsd = ((u.cacheRead || 0) * rate.input * CACHE_READ_MULTIPLIER) / 1e6;
  return {
    usd: inputUsd + cacheWriteUsd + cacheReadUsd + outputUsd,
    outputUsd,
    // Dollars per token class. `cacheWrite` is the total; `cacheWrite1h` and
    // `cacheWrite5m` break it down over what the log actually classified and
    // must never be summed into it — the unclassified remainder is priced into
    // the total at the 5-minute rate and stays visible as the gap, exactly as
    // `cacheCreate1h`/`cacheCreate5m` do on the token side.
    usdByClass: {
      input: inputUsd,
      cacheWrite: cacheWriteUsd,
      cacheWrite1h: ((u.cacheCreate1h || 0) * CACHE_WRITE_1H_MULTIPLIER * rate.input) / 1e6,
      cacheWrite5m: ((u.cacheCreate5m || 0) * CACHE_WRITE_5M_MULTIPLIER * rate.input) / 1e6,
      cacheRead: cacheReadUsd,
      output: outputUsd,
    },
    priced: true,
  };
}

export function costFor(record) {
  return priceUsage(record.usage, record.model, record.timestamp) || { usd: 0, priced: false };
}
