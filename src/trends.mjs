import { buildReport } from "./report.mjs";
import { displayProject } from "./labels.mjs";

function startOfUtcDay(now = new Date()) {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

function scopedReport(records, start, end) {
  return buildReport(records.filter((record) => {
    const time = Date.parse(record.timestamp || "");
    return Number.isFinite(time) && time >= start && time < end;
  }));
}

/**
 * Dollars per key, on a null-prototype map. The keys are model ids and project
 * fingerprints read out of log files, so `usd["constructor"]` on a plain object
 * would resolve to an inherited value and be differenced as if it were spend.
 */
function usdByKey(rows) {
  const map = Object.create(null);
  for (const [id, value] of rows) map[id] = value?.usd || 0;
  return map;
}

const DRIVER_LIMIT = 5;

/**
 * Per-key dollar deltas between the two windows, largest absolute change first.
 * Keys whose spend did not move are dropped rather than filling a slot with
 * $0.00.
 */
function deltaRows(current, previous, key) {
  return [...new Set([...Object.keys(current), ...Object.keys(previous)])]
    .map((id) => ({ [key]: id, deltaUsd: (current[id] || 0) - (previous[id] || 0) }))
    .filter((row) => row.deltaUsd !== 0)
    .sort((a, b) => Math.abs(b.deltaUsd) - Math.abs(a.deltaUsd))
    .slice(0, DRIVER_LIMIT);
}

/**
 * Which keys moved between the two windows. Models come from the full `byModel`
 * map, so that side is complete. Projects come from each report's `topProjects`
 * list, which is the only per-project breakdown a report carries: a project
 * that ranks outside both top lists is not in either input and is therefore out
 * of scope for this attribution, not reported as unchanged.
 *
 * These are descriptive deltas. A key at the top of the list is where the money
 * moved, not the reason it moved.
 */
function drivers(current, previous) {
  return {
    byModel: deltaRows(usdByKey(Object.entries(current.byModel)), usdByKey(Object.entries(previous.byModel)), "model"),
    byProject: deltaRows(
      usdByKey(current.topProjects.map((project) => [project.id, project])),
      usdByKey(previous.topProjects.map((project) => [project.id, project])),
      "id",
    ),
  };
}

/** Compare the most recent complete days with the preceding equal-sized period. */
export function analyzeTrend(records, { days = 7, now = new Date() } = {}) {
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error("Trend days must be an integer from 1 to 90.");
  // Today is deliberately excluded from both windows. Including the hours
  // elapsed so far in the current window while comparing them against whole
  // days made every morning read as a spending decline. It is reported
  // separately instead, so today's spend is still visible.
  const end = startOfUtcDay(now);
  const currentStart = end - days * 86_400_000;
  const previousStart = currentStart - days * 86_400_000;
  const current = scopedReport(records, currentStart, end);
  const previous = scopedReport(records, previousStart, currentStart);
  const today = scopedReport(records, end, Math.max(end, now.getTime()));
  const deltaUsd = current.total.usd - previous.total.usd;
  return {
    days,
    current: { start: new Date(currentStart).toISOString().slice(0, 10), end: new Date(end - 1).toISOString().slice(0, 10), report: current },
    previous: { start: new Date(previousStart).toISOString().slice(0, 10), end: new Date(currentStart - 1).toISOString().slice(0, 10), report: previous },
    today: { day: new Date(end).toISOString().slice(0, 10), partial: true, report: today },
    deltaUsd,
    deltaPct: previous.total.usd ? deltaUsd / previous.total.usd : null,
    drivers: drivers(current, previous),
  };
}

export function humanTrend(trend, labels = {}, revealedNames = {}) {
  const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
  const pct = trend.deltaPct == null ? "n/a" : `${(trend.deltaPct * 100).toFixed(1)}%`;
  const lines = [
    `agent-finops trend — ${trend.days}-day periods`,
    `Current  ${trend.current.start}–${trend.current.end}: ${money.format(trend.current.report.total.usd)}`,
    `Previous ${trend.previous.start}–${trend.previous.end}: ${money.format(trend.previous.report.total.usd)}`,
    `Change: ${money.format(trend.deltaUsd)} (${pct})`,
    // Outside the comparison on purpose: an incomplete day is not comparable to
    // a whole one, but hiding it would look like the day had no spend at all.
    `Today ${trend.today.day} (partial): ${money.format(trend.today.report.total.usd)}`,
    "",
    "Current daily estimates:",
  ];
  for (const [day, value] of Object.entries(trend.current.report.byDay)) lines.push(`  ${day}  ${money.format(value.usd)}  ${value.usage.total.toLocaleString()} tokens`);
  // Where the change sits, not what produced it. Three rows a side: past that
  // the deltas are usually rounding against the headline figure.
  const byModel = trend.drivers?.byModel?.slice(0, 3) || [];
  const byProject = trend.drivers?.byProject?.slice(0, 3) || [];
  if (byModel.length || byProject.length) {
    lines.push("", "Largest drivers:");
    for (const row of byModel) lines.push(`  model    ${row.model.padEnd(24)} ${money.format(row.deltaUsd)}`);
    for (const row of byProject) lines.push(`  project  ${displayProject(row.id, labels, revealedNames).padEnd(24)} ${money.format(row.deltaUsd)}`);
    if (byProject.length) lines.push("  Project deltas cover the projects ranked highest in either window.");
  }
  lines.push("", "Use this as a spending trend, not proof that a configuration change caused it. Compare tagged, matched task windows for causal experiments.");
  return lines.join("\n");
}
