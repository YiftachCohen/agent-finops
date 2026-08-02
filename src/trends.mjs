import { buildReport } from "./report.mjs";

function startOfUtcDay(now = new Date()) {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

function scopedReport(records, start, end) {
  return buildReport(records.filter((record) => {
    const time = Date.parse(record.timestamp || "");
    return Number.isFinite(time) && time >= start && time < end;
  }));
}

/** Compare the most recent complete days with the preceding equal-sized period. */
export function analyzeTrend(records, { days = 7, now = new Date() } = {}) {
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error("Trend days must be an integer from 1 to 90.");
  const end = startOfUtcDay(now) + 86_400_000;
  const currentStart = end - days * 86_400_000;
  const previousStart = currentStart - days * 86_400_000;
  const current = scopedReport(records, currentStart, end);
  const previous = scopedReport(records, previousStart, currentStart);
  const deltaUsd = current.total.usd - previous.total.usd;
  return {
    days,
    current: { start: new Date(currentStart).toISOString().slice(0, 10), end: new Date(end - 1).toISOString().slice(0, 10), report: current },
    previous: { start: new Date(previousStart).toISOString().slice(0, 10), end: new Date(currentStart - 1).toISOString().slice(0, 10), report: previous },
    deltaUsd,
    deltaPct: previous.total.usd ? deltaUsd / previous.total.usd : null,
  };
}

export function humanTrend(trend) {
  const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
  const pct = trend.deltaPct == null ? "n/a" : `${(trend.deltaPct * 100).toFixed(1)}%`;
  const lines = [
    `agent-finops trend — ${trend.days}-day periods`,
    `Current  ${trend.current.start}–${trend.current.end}: ${money.format(trend.current.report.total.usd)}`,
    `Previous ${trend.previous.start}–${trend.previous.end}: ${money.format(trend.previous.report.total.usd)}`,
    `Change: ${money.format(trend.deltaUsd)} (${pct})`,
    "",
    "Current daily estimates:",
  ];
  for (const [day, value] of Object.entries(trend.current.report.byDay)) lines.push(`  ${day}  ${money.format(value.usd)}  ${value.usage.total.toLocaleString()} tokens`);
  lines.push("", "Use this as a spending trend, not proof that a configuration change caused it. Compare tagged, matched task windows for causal experiments.");
  return lines.join("\n");
}
