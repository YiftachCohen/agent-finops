import { canonicalModelId, costFor } from "./rates.mjs";

const EMPTY_USAGE = () => ({ input: 0, cacheCreate: 0, cacheRead: 0, output: 0, total: 0 });

function addUsage(target, usage) {
  target.input += usage.input;
  target.cacheCreate += usage.cacheCreate;
  target.cacheRead += usage.cacheRead;
  target.output += usage.output;
  target.total += usage.input + usage.cacheCreate + usage.cacheRead + usage.output;
}

function bucket() {
  return { usage: EMPTY_USAGE(), usd: 0, outputUsd: 0, requests: 0, unpricedTokens: 0 };
}

function addRecord(target, record, cost) {
  addUsage(target.usage, record.usage);
  target.requests++;
  if (cost.priced) {
    target.usd += cost.usd;
    target.outputUsd += cost.outputUsd;
  }
  else target.unpricedTokens += record.usage.input + record.usage.cacheCreate + record.usage.cacheRead + record.usage.output;
}

function attributedRecord(record, divisor) {
  if (divisor <= 1) return record;
  return {
    ...record,
    usage: Object.fromEntries(Object.entries(record.usage).map(([key, value]) => [key, value / divisor])),
  };
}

function attributedCost(cost, divisor) {
  if (divisor <= 1 || !cost.priced) return cost;
  return { ...cost, usd: cost.usd / divisor, outputUsd: cost.outputUsd / divisor };
}

function toolBucket() {
  return { ...bucket(), calls: 0, followOnRequests: 0 };
}

function datedBucketKey(timestamp) {
  const time = Date.parse(timestamp || "");
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : "<unknown-date>";
}

function keepLast(records) {
  const kept = new Map();
  let missingIds = 0;
  let duplicatesDropped = 0;
  for (const record of records) {
    const key = record.messageId && record.requestId ? `${record.messageId}:${record.requestId}` : `unique:${missingIds++}`;
    if (kept.has(key)) duplicatesDropped++;
    kept.set(key, record);
  }
  return { records: [...kept.values()], duplicatesDropped, missingIds };
}

/** Aggregate a bounded list of metadata-only accounting records. */
export function buildReport(rawRecords, { sinceMs = null, sessionLimit = 8, toolLimit = 20 } = {}) {
  const dated = rawRecords.filter((record) => {
    if (!sinceMs) return true;
    const timestamp = Date.parse(record.timestamp || "");
    return Number.isFinite(timestamp) && timestamp >= sinceMs;
  });
  const dedup = keepLast(dated);
  const all = bucket();
  const byModel = {};
  const bySession = {};
  const byProject = {};
  const byDay = {};
  const byTool = {};
  for (const record of dedup.records) {
    const cost = costFor(record);
    addRecord(all, record, cost);
    const model = canonicalModelId(record.model) || "<unknown>";
    byModel[model] ||= bucket();
    bySession[record.source] ||= bucket();
    byProject[record.project || "<unknown-project>"] ||= bucket();
    byDay[datedBucketKey(record.timestamp)] ||= bucket();
    addRecord(byModel[model], record, cost);
    addRecord(bySession[record.source], record, cost);
    addRecord(byProject[record.project || "<unknown-project>"], record, cost);
    addRecord(byDay[datedBucketKey(record.timestamp)], record, cost);
    for (const name of new Set(record.tools || [])) {
      byTool[name] ||= toolBucket();
      byTool[name].calls++;
    }
    const priorTools = [...new Set(record.priorTools || [])];
    for (const name of priorTools) {
      byTool[name] ||= toolBucket();
      addRecord(byTool[name], attributedRecord(record, priorTools.length), attributedCost(cost, priorTools.length));
      byTool[name].followOnRequests++;
    }
  }
  const promptTokens = all.usage.input + all.usage.cacheCreate + all.usage.cacheRead;
  const sessions = Object.entries(bySession)
    .map(([id, value]) => ({ id, ...value }))
    .sort((a, b) => b.usd - a.usd || b.usage.total - a.usage.total)
    .slice(0, sessionLimit);
  const projects = Object.entries(byProject)
    .map(([id, value]) => ({ id, ...value }))
    .sort((a, b) => b.usd - a.usd || b.usage.total - a.usage.total)
    .slice(0, 8);
  const tools = Object.entries(byTool)
    .map(([name, value]) => ({ name, ...value }))
    .sort((a, b) => b.usd - a.usd || b.usage.total - a.usage.total || b.calls - a.calls)
    .slice(0, toolLimit);
  return {
    generatedAt: new Date().toISOString(),
    scope: { sinceMs, recordsRead: rawRecords.length, recordsAfterDateFilter: dated.length },
    total: all,
    byModel: Object.fromEntries(Object.entries(byModel).sort((a, b) => b[1].usd - a[1].usd || b[1].usage.total - a[1].usage.total)),
    byDay: Object.fromEntries(Object.entries(byDay).sort(([a], [b]) => a.localeCompare(b))),
    topProjects: projects,
    topSessions: sessions,
    topTools: tools,
    diagnostics: dedup,
    insights: {
      cacheReadShare: promptTokens ? all.usage.cacheRead / promptTokens : null,
      outputCostShare: all.usd ? all.outputUsd / all.usd : null,
      unpricedTokens: all.unpricedTokens,
    },
  };
}

export function hotspotAnalysis(report) {
  const modelRows = Object.entries(report.byModel);
  const topModel = modelRows[0];
  const recommendations = [];
  if (topModel && report.total.usd > 0) {
    const share = topModel[1].usd / report.total.usd;
    if (share >= 0.5) recommendations.push({
      kind: "model-concentration",
      severity: "high",
      evidence: `${topModel[0]} is ${(share * 100).toFixed(1)}% of estimated spend.`,
      action: "Run a tagged, comparable task set with a lower-cost model before changing the global default.",
    });
  }
  if (report.insights.outputCostShare != null && report.insights.outputCostShare >= 0.15) recommendations.push({
    kind: "output-cost",
    severity: "medium",
    evidence: `Output tokens are ${(report.insights.outputCostShare * 100).toFixed(1)}% of estimated spend.`,
    action: "Constrain verbose plans and repeated explanations; preserve detailed output only for failing diagnostics.",
  });
  if (report.insights.cacheReadShare != null) {
    const efficient = report.insights.cacheReadShare >= 0.8;
    recommendations.push({
      kind: "cache",
      severity: efficient ? "info" : "medium",
      evidence: `Cache reads are ${(report.insights.cacheReadShare * 100).toFixed(1)}% of prompt tokens.`,
      action: efficient
        ? "Caching is already healthy; prioritize model concentration and tool-output volume before changing TTL policy."
        : "Inspect directory/worktree changes, session restarts, and MCP catalog size before paying for a longer cache TTL.",
    });
  }
  if (report.topSessions[0]?.usd >= 10) recommendations.push({
    kind: "session-outlier",
    severity: "medium",
    evidence: `The top anonymous session cost ${formatUsd(report.topSessions[0].usd)}.`,
    action: "Use session-level tags to compare its workflow against cheaper successful sessions; do not inspect transcript content by default.",
  });
  const topMcp = report.topTools?.find((tool) => tool.name.startsWith("mcp__"));
  if (topMcp?.usd >= 10) recommendations.push({
    kind: "mcp-follow-on-cost",
    severity: topMcp.usd / report.total.usd >= 0.2 ? "high" : "medium",
    evidence: `${topMcp.name} has ${formatUsd(topMcp.usd)} in equally apportioned follow-on request cost across ${topMcp.followOnRequests} turn(s).`,
    action: "Inspect this MCP's schema and result size, then compare a tagged workflow with fewer calls or a narrower response.",
  });
  return { generatedAt: new Date().toISOString(), recommendations };
}

export function compareSnapshots(leftName, left, rightName, right) {
  const delta = right.total.usd - left.total.usd;
  const percent = left.total.usd ? delta / left.total.usd : null;
  const allModels = new Set([...Object.keys(left.byModel), ...Object.keys(right.byModel)]);
  const byModel = [...allModels].map((model) => ({
    model,
    leftUsd: left.byModel[model]?.usd || 0,
    rightUsd: right.byModel[model]?.usd || 0,
  })).map((row) => ({ ...row, deltaUsd: row.rightUsd - row.leftUsd }))
    .sort((a, b) => Math.abs(b.deltaUsd) - Math.abs(a.deltaUsd));
  return { leftName, rightName, left, right, deltaUsd: delta, deltaPct: percent, byModel };
}

function formatUsd(value) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
}

export function humanHotspots(analysis) {
  if (!analysis.recommendations.length) return "No cost hotspots found in this period.";
  return ["agent-finops hotspots", ...analysis.recommendations.flatMap((item) => [
    "",
    `[${item.severity}] ${item.kind}`,
    `  Evidence: ${item.evidence}`,
    `  Next: ${item.action}`,
  ])].join("\n");
}

export function humanComparison(comparison) {
  const percent = comparison.deltaPct == null ? "n/a" : `${(comparison.deltaPct * 100).toFixed(1)}%`;
  const lines = [
    `agent-finops compare: ${comparison.leftName} → ${comparison.rightName}`,
    `Estimated cost: ${formatUsd(comparison.left.total.usd)} → ${formatUsd(comparison.right.total.usd)} (${formatUsd(comparison.deltaUsd)}, ${percent})`,
    "",
    "Largest model deltas:",
  ];
  for (const row of comparison.byModel.slice(0, 8)) lines.push(`  ${row.model.padEnd(24)} ${formatUsd(row.deltaUsd)}`);
  lines.push("", "Comparison is descriptive. Use matching task sets and the same time window before attributing a cost difference to a change.");
  return lines.join("\n");
}

export function humanSessions(sessions) {
  if (!sessions.length) return "No sessions found in this period.";
  const number = new Intl.NumberFormat("en-US");
  const lines = ["Sessions (anonymous local IDs):"];
  for (const session of sessions) lines.push(`  ${session.id}  ${formatUsd(session.usd)}  ${number.format(session.usage.total)} tokens  ${session.requests} turns`);
  lines.push("", "Use `agent-finops session ID` for one session or `compare-sessions A B` for a direct comparison.");
  return lines.join("\n");
}

export function humanTools(tools, { onlyMcp = false } = {}) {
  const rows = onlyMcp ? tools.filter((tool) => tool.name.startsWith("mcp__")) : tools;
  if (!rows.length) return onlyMcp ? "No MCP tool calls found in this period." : "No tool calls found in this period.";
  const number = new Intl.NumberFormat("en-US");
  const label = onlyMcp ? "MCP" : "Tool/MCP";
  const lines = [`${label} follow-on attribution (local estimate):`];
  for (const tool of rows) lines.push(`  ${tool.name.padEnd(34)} ${formatUsd(tool.usd).padStart(10)}  ${number.format(tool.usage.total)} tokens  ${tool.calls} call(s)  ${tool.followOnRequests} follow-on turn(s)`);
  lines.push("", "Each billed assistant turn immediately after tool use is split equally among tools called in the prior assistant message. This is correlation for prioritization, not an invoice line item or proof of causation.");
  return lines.join("\n");
}

export function humanReport(report) {
  const number = new Intl.NumberFormat("en-US");
  const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
  const percent = (value) => (value == null ? "n/a" : `${(value * 100).toFixed(1)}%`);
  const u = report.total.usage;
  const lines = [
    "agent-finops — local-only estimate",
    `Scope: ${report.scope.recordsAfterDateFilter.toLocaleString()} usage records before keep-last deduplication`,
    `Estimated cost: ${usd.format(report.total.usd)}${report.total.unpricedTokens ? " (partial; unpriced models present)" : ""}`,
    `Tokens: ${number.format(u.total)}  input ${number.format(u.input)}  cache-write ${number.format(u.cacheCreate)}  cache-read ${number.format(u.cacheRead)}  output ${number.format(u.output)}`,
    `Cache-read share: ${percent(report.insights.cacheReadShare)} · output-cost share: ${percent(report.insights.outputCostShare)}`,
    "",
    "By model:",
  ];
  for (const [model, value] of Object.entries(report.byModel)) {
    lines.push(`  ${model.padEnd(24)} ${usd.format(value.usd).padStart(10)}  ${number.format(value.usage.total).padStart(12)} tokens  ${value.requests} turns`);
  }
  if (report.topSessions.length) {
    lines.push("", "Top anonymous sessions:");
    for (const value of report.topSessions) lines.push(`  ${value.id}  ${usd.format(value.usd)}  ${number.format(value.usage.total)} tokens`);
  }
  if (report.topTools?.length) {
    lines.push("", "Top tool/MCP follow-on estimates:");
    for (const tool of report.topTools.slice(0, 5)) lines.push(`  ${tool.name.padEnd(34)} ${usd.format(tool.usd)}  ${number.format(tool.usage.total)} tokens  ${tool.followOnRequests} follow-on turns`);
    lines.push("  Attribution is equally split across tools in the prior tool-call message; use `agent-finops tools` for details.");
  }
  lines.push("", "Diagnostics:");
  if (report.diagnostics.duplicatesDropped) lines.push(`  ${report.diagnostics.duplicatesDropped} streaming duplicate(s) collapsed with keep-last semantics.`);
  if (report.diagnostics.missingIds) lines.push(`  ${report.diagnostics.missingIds} record(s) lacked a full dedup key and were conservatively retained.`);
  if (report.total.unpricedTokens) lines.push(`  ${number.format(report.total.unpricedTokens)} token(s) belong to unpriced models; no dollar figure was invented.`);
  if (!report.diagnostics.duplicatesDropped && !report.diagnostics.missingIds && !report.total.unpricedTokens) lines.push("  No accounting warnings.");
  lines.push("", "No network · no subprocesses · local metadata only · content redacted before JSON decoding");
  return lines.join("\n");
}
