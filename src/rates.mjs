// Local list-price estimates in USD per million tokens. No runtime lookup.

const RATES = {
  "claude-fable-5": { input: 10, output: 50 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-opus-4-5": { input: 5, output: 25 },
  "claude-opus-4-1": { input: 15, output: 75 },
  "claude-opus-4": { input: 15, output: 75 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-sonnet-4": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-3-5-haiku": { input: 0.8, output: 4 },
};

const ALIASES = { opus: "claude-opus-5", sonnet: "claude-sonnet-5", haiku: "claude-haiku-4-5" };

export function canonicalModelId(model) {
  if (typeof model !== "string") return "";
  return model
    .toLowerCase()
    .replace(/\[1m]$/, "")
    .replace(/^(us|eu|apac|us-gov)\./, "")
    .replace(/^anthropic\./, "")
    .replace(/-v\d+:\d+$/, "")
    .replace(/-\d{8}$/, "");
}

export function rateFor(model) {
  const id = canonicalModelId(model);
  return RATES[id] || RATES[ALIASES[id]] || null;
}

export function costFor(record) {
  const rate = rateFor(record.model);
  if (!rate) return { usd: 0, priced: false };
  const u = record.usage;
  const outputUsd = (u.output * rate.output) / 1e6;
  return {
    usd: (u.input * rate.input + u.cacheCreate * rate.input * 1.25 + u.cacheRead * rate.input * 0.1) / 1e6 + outputUsd,
    outputUsd,
    priced: true,
  };
}
