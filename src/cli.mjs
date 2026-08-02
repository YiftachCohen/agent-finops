#!/usr/bin/env node

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startDashboard } from "./dashboard.mjs";
import { filterReport, hookConfig, processPostToolUse, pruneArtifacts, readArtifact } from "./filter.mjs";
import { defaultIndexPath, indexedRecords, loadIndex, saveIndex, saveTag, updateIndex } from "./index.mjs";
import { defaultLabelsPath, displayProject, loadLabels, saveLabel } from "./labels.mjs";
import { findClaudeJsonl } from "./logs.mjs";
import { buildReport, compareSnapshots, hotspotAnalysis, humanComparison, humanHotspots, humanReport, humanSessions, humanTools } from "./report.mjs";
import { analyzeTrend, humanTrend } from "./trends.mjs";

function usage(message = null) {
  console.log(message || `Usage:
  agent-finops scan [--log-dir PATH] [--index PATH]
  agent-finops report [--since 7d] [--json] [--fresh]
  agent-finops dashboard [--since 30d] [--port 7474] [--fresh]
  agent-finops hotspots [--since 7d] [--json] [--fresh]
  agent-finops tools [--since 7d] [--limit 20] [--json] [--fresh]
  agent-finops mcp [--since 7d] [--limit 20] [--json] [--fresh]
  agent-finops sessions [--since 7d] [--limit 20] [--json] [--fresh]
  agent-finops session SESSION_ID [--since 7d] [--json] [--fresh]
  agent-finops compare-sessions LEFT_ID RIGHT_ID [--since 7d] [--json] [--fresh]
  agent-finops projects [--since 7d] [--json] [--fresh]
  agent-finops label PROJECT_ID "Friendly name"
  agent-finops trend [--days 7] [--json] [--fresh]
  agent-finops tag NAME [--since 7d] [--fresh]
  agent-finops compare BASELINE EXPERIMENT [--json]
  agent-finops hook-config
  agent-finops hook                         # Claude Code PostToolUse entry point
  agent-finops filter-report [--since 7d]
  agent-finops artifact ID
  agent-finops prune --older-than 7d
  agent-finops doctor [--log-dir PATH] [--index PATH]

Everything is local. The index stores hashed IDs and token metadata only.`);
}

function parseArgs(argv) {
  const args = {
    command: argv[0] === "--help" || argv[0] === "-h" ? "report" : (argv[0] || "report"),
    positional: [],
    json: false,
    fresh: false,
    since: null,
    olderThan: null,
    days: 7,
    limit: 20,
    port: 7474,
    logDir: process.env.AGENT_FINOPS_LOG_DIR || join(homedir(), ".claude", "projects"),
    indexPath: process.env.AGENT_FINOPS_INDEX || defaultIndexPath(),
  };
  if (argv[0] === "--help" || argv[0] === "-h") args.help = true;
  for (let i = 1; i < argv.length; i++) {
    const value = argv[i];
    if (value === "--json") args.json = true;
    else if (value === "--fresh") args.fresh = true;
    else if (value === "--since") args.since = argv[++i];
    else if (value === "--older-than") args.olderThan = argv[++i];
    else if (value === "--days") args.days = Number(argv[++i]);
    else if (value === "--limit") args.limit = Number(argv[++i]);
    else if (value === "--port") args.port = Number(argv[++i]);
    else if (value === "--log-dir") args.logDir = argv[++i];
    else if (value === "--index") args.indexPath = argv[++i];
    else if (value === "--help" || value === "-h") args.help = true;
    else args.positional.push(value);
  }
  return args;
}

function listLimit(value) {
  if (!Number.isInteger(value) || value < 1 || value > 10_000) throw new Error("--limit must be an integer between 1 and 10000.");
  return value;
}

function sinceToMs(value) {
  if (!value) return null;
  const match = /^(\d+)([dhw])$/.exec(value);
  if (!match) throw new Error(`Invalid --since value ${value}; use 24h, 7d, or 2w.`);
  return Date.now() - Number(match[1]) * { d: 86_400_000, h: 3_600_000, w: 604_800_000 }[match[2]];
}

function durationToMs(value, flag) {
  if (!value) throw new Error(`${flag} requires a duration such as 24h, 7d, or 2w.`);
  const match = /^(\d+)([dhw])$/.exec(value);
  if (!match) throw new Error(`Invalid ${flag} value ${value}; use 24h, 7d, or 2w.`);
  return Number(match[1]) * { d: 86_400_000, h: 3_600_000, w: 604_800_000 }[match[2]];
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let value = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { value += chunk; });
    process.stdin.on("end", () => resolve(value));
    process.stdin.on("error", reject);
  });
}

async function scan(args) {
  const files = findClaudeJsonl(args.logDir);
  if (!files.length) throw new Error(`No Claude Code JSONL logs found under ${args.logDir}`);
  const updated = await updateIndex(loadIndex(args.indexPath), files);
  saveIndex(args.indexPath, updated.index);
  return updated;
}

async function reportFor(args) {
  let index = loadIndex(args.indexPath);
  let scanStats = null;
  if (args.fresh || !index.scannedAt) {
    const updated = await scan(args);
    index = updated.index;
    scanStats = updated.stats;
  }
  const report = buildReport(indexedRecords(index), { sinceMs: sinceToMs(args.since) });
  report.index = { path: args.indexPath, scannedAt: index.scannedAt || null, scanStats };
  return { index, report };
}

function projects(report, labels) {
  const result = report.topProjects.map(({ id, usd, usage, requests }) => ({ id, label: labels[id] || null, usd, tokens: usage.total, requests }));
  return result;
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (error) { console.error(error.message); usage(); process.exitCode = 2; return; }
  if (args.help) return usage();
  try {
    if (args.command === "hook") {
      // A hook must write only a valid decision object on stdout. Any error is
      // deliberately non-blocking so an accounting feature cannot break coding.
      try {
        const event = JSON.parse(await readStdin());
        const result = processPostToolUse(event);
        if (result) console.log(JSON.stringify(result));
      } catch { /* keep the original tool result */ }
      return;
    }
    if (args.command === "hook-config") {
      console.log(JSON.stringify(hookConfig(fileURLToPath(import.meta.url)), null, 2));
      return;
    }
    if (args.command === "artifact") {
      const [id] = args.positional;
      if (!id) throw new Error("artifact requires an id printed by the hook.");
      const artifact = readArtifact(id);
      process.stdout.write(artifact.stdout || "");
      if (artifact.stderr) process.stderr.write(artifact.stderr);
      return;
    }
    if (args.command === "filter-report") {
      const report = filterReport({ sinceMs: args.since ? sinceToMs(args.since) : null });
      if (args.json) console.log(JSON.stringify(report, null, 2));
      else console.log(`Filtered Bash results: ${report.events}\nRaw output: ${report.rawChars.toLocaleString()} chars\nSent to Claude: ${report.sentChars.toLocaleString()} chars\nRemoved: ${report.savedChars.toLocaleString()} chars (~${report.estimatedTokensSaved.toLocaleString()} input tokens)`);
      return;
    }
    if (args.command === "prune") {
      const removed = pruneArtifacts({ olderThanMs: durationToMs(args.olderThan, "--older-than") });
      console.log(`Removed ${removed} retained raw-output artifact(s).`);
      return;
    }
    if (args.command === "doctor") {
      console.log(existsSync(args.logDir) ? `OK: local log directory is readable: ${args.logDir}` : `Missing local log directory: ${args.logDir}`);
      console.log(existsSync(args.indexPath) ? `OK: metadata index exists: ${args.indexPath}` : `Index will be created locally on first scan: ${args.indexPath}`);
      console.log("Network access: disabled by design");
      console.log("Stored state: hashed IDs, timestamps, model IDs, and token counters only");
      console.log(existsSync(defaultLabelsPath()) ? `OK: local project labels exist: ${defaultLabelsPath()}` : `Optional labels: ${defaultLabelsPath()}`);
      return;
    }
    if (args.command === "scan") {
      const updated = await scan(args);
      const output = { indexPath: args.indexPath, scannedAt: updated.index.scannedAt, records: updated.records.length, ...updated.stats };
      console.log(args.json ? JSON.stringify(output, null, 2) : `Indexed ${output.records.toLocaleString()} metadata records · ${output.filesParsed} files parsed · ${output.filesReused} reused · ${output.parseErrors} parse errors`);
      return;
    }
    if (args.command === "compare") {
      const [leftName, rightName] = args.positional;
      const index = loadIndex(args.indexPath);
      if (!leftName || !rightName) throw new Error("compare requires BASELINE and EXPERIMENT tag names.");
      if (!index.tags[leftName] || !index.tags[rightName]) throw new Error("Both comparison tags must exist. Run `agent-finops tag NAME --since 24h` first.");
      const comparison = compareSnapshots(leftName, index.tags[leftName], rightName, index.tags[rightName]);
      console.log(args.json ? JSON.stringify(comparison, null, 2) : humanComparison(comparison));
      return;
    }
    if (args.command === "label") {
      const [id, ...parts] = args.positional;
      const label = parts.join(" ");
      saveLabel(id, label);
      console.log(`Saved local label '${label}' for ${id}.`);
      return;
    }
    const { index, report } = await reportFor(args);
    if (args.command === "dashboard") {
      const dashboardReport = buildReport(indexedRecords(index), { sinceMs: sinceToMs(args.since), sessionLimit: 12, toolLimit: 12 });
      const running = await startDashboard(dashboardReport, hotspotAnalysis(dashboardReport), { port: args.port });
      console.log(`Dashboard running at ${running.url}`);
      console.log("Loopback only. Press Ctrl-C to stop.");
      await new Promise((resolve) => running.server.once("close", resolve));
      return;
    }
    if (args.command === "report") {
      console.log(args.json ? JSON.stringify(report, null, 2) : humanReport(report));
      return;
    }
    if (args.command === "hotspots") {
      const analysis = hotspotAnalysis(report);
      console.log(args.json ? JSON.stringify({ report, analysis }, null, 2) : humanHotspots(analysis));
      return;
    }
    if (args.command === "sessions") {
      const sessionReport = buildReport(indexedRecords(index), { sinceMs: sinceToMs(args.since), sessionLimit: listLimit(args.limit) });
      console.log(args.json ? JSON.stringify(sessionReport.topSessions, null, 2) : humanSessions(sessionReport.topSessions));
      return;
    }
    if (args.command === "session") {
      const [id] = args.positional;
      if (!id) throw new Error("session requires a session ID printed by `agent-finops sessions`.");
      const sessionReport = buildReport(indexedRecords(index).filter((record) => record.source === id), { sinceMs: sinceToMs(args.since), toolLimit: listLimit(args.limit) });
      if (!sessionReport.scope.recordsAfterDateFilter) throw new Error(`No usage records found for session ${id} in this period.`);
      console.log(args.json ? JSON.stringify(sessionReport, null, 2) : humanReport(sessionReport));
      return;
    }
    if (args.command === "compare-sessions") {
      const [leftId, rightId] = args.positional;
      if (!leftId || !rightId) throw new Error("compare-sessions requires two IDs printed by `agent-finops sessions`.");
      const options = { sinceMs: sinceToMs(args.since), toolLimit: listLimit(args.limit) };
      const records = indexedRecords(index);
      const left = buildReport(records.filter((record) => record.source === leftId), options);
      const right = buildReport(records.filter((record) => record.source === rightId), options);
      if (!left.scope.recordsAfterDateFilter || !right.scope.recordsAfterDateFilter) throw new Error("One or both sessions have no usage records in this period.");
      const comparison = compareSnapshots(leftId, left, rightId, right);
      console.log(args.json ? JSON.stringify(comparison, null, 2) : humanComparison(comparison));
      return;
    }
    if (args.command === "tools" || args.command === "mcp") {
      const toolReport = buildReport(indexedRecords(index), { sinceMs: sinceToMs(args.since), toolLimit: Number.MAX_SAFE_INTEGER });
      const rows = args.command === "mcp" ? toolReport.topTools.filter((tool) => tool.name.startsWith("mcp__")) : toolReport.topTools;
      const output = rows.slice(0, listLimit(args.limit));
      console.log(args.json ? JSON.stringify(output, null, 2) : humanTools(output, { onlyMcp: args.command === "mcp" }));
      return;
    }
    if (args.command === "projects") {
      const output = projects(report, loadLabels());
      if (args.json) console.log(JSON.stringify(output, null, 2));
      else console.log(["Projects:", ...output.map((item) => `  ${(item.label || item.id).padEnd(28)} $${item.usd.toFixed(2)}  ${item.tokens.toLocaleString()} tokens  ${item.requests} turns${item.label ? `  [${item.id}]` : ""}`), "", "Project paths are never stored or printed. Use `agent-finops label PROJECT_ID \"Name\"` to label an id locally."].join("\n"));
      return;
    }
    if (args.command === "trend") {
      const trend = analyzeTrend(indexedRecords(index), { days: args.days });
      console.log(args.json ? JSON.stringify(trend, null, 2) : humanTrend(trend));
      return;
    }
    if (args.command === "tag") {
      const [name] = args.positional;
      if (!name) throw new Error("tag requires a name, for example `agent-finops tag baseline-24h --since 24h`.");
      const tag = saveTag(index, name, report);
      saveIndex(args.indexPath, index);
      console.log(args.json ? JSON.stringify({ name, tag }, null, 2) : `Saved local metadata snapshot '${name}' (${tag.total.requests} turns, $${tag.total.usd.toFixed(2)} estimate).`);
      return;
    }
    usage(`Unknown command: ${args.command}`);
    process.exitCode = 2;
  } catch (error) {
    console.error(`agent-finops: ${error.message}`);
    process.exitCode = 1;
  }
}

main();
