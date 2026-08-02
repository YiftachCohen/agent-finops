#!/usr/bin/env node

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startDashboard } from "./dashboard.mjs";
import { filterReport, hookConfig, processPostToolUse, pruneArtifacts, readArtifact } from "./filter.mjs";
import { defaultIndexPath, indexedRecords, loadIndex, pruneRetired, saveIndex, saveTag, updateIndex } from "./index.mjs";
import { defaultLabelsPath, displayProject, loadLabels, saveLabel } from "./labels.mjs";
import { findClaudeJsonl } from "./logs.mjs";
import { buildReport, compareSnapshots, hotspotAnalysis, humanComparison, humanHotspots, humanReport, humanSessions, humanTools } from "./report.mjs";
import { analyzeTrend, humanTrend } from "./trends.mjs";

// An index older than this is refreshed before any report is built.
const INDEX_MAX_AGE_MS = 3_600_000;

function usage(message = null) {
  console.log(message || `Usage:
  agent-finops scan [--log-dir PATH] [--index PATH]
  agent-finops report [WINDOW] [--json] [--fresh]
  agent-finops dashboard [WINDOW] [--port 7474] [--fresh]
  agent-finops hotspots [WINDOW] [--json] [--fresh]
  agent-finops tools [WINDOW] [--limit 20] [--json] [--fresh]
  agent-finops mcp [WINDOW] [--limit 20] [--json] [--fresh]
  agent-finops sessions [WINDOW] [--limit 20] [--json] [--fresh]
  agent-finops session SESSION_ID [WINDOW] [--json] [--fresh]
  agent-finops compare-sessions LEFT_ID RIGHT_ID [WINDOW] [--json] [--fresh]
  agent-finops projects [WINDOW] [--limit 20] [--json] [--fresh]
  agent-finops project PROJECT_ID [WINDOW] [--json] [--fresh]
  agent-finops label PROJECT_ID "Friendly name"
  agent-finops trend [--days 7] [--json] [--fresh]
  agent-finops tag NAME [WINDOW] [--fresh]
  agent-finops compare BASELINE EXPERIMENT [--json]
  agent-finops hook-config
  agent-finops hook                         # Claude Code PostToolUse entry point
  agent-finops filter-report [--since 7d]
  agent-finops artifact ID
  agent-finops prune --older-than 7d
  agent-finops prune-index --older-than 90d
  agent-finops doctor [--log-dir PATH] [--index PATH]

WINDOW is either --since 7d (relative to now) or --from/--to (absolute), never
both. --from and --to take 2026-07-01 (UTC midnight) or a full ISO-8601
timestamp, and the window is [from, to): the start is included and the end is
excluded, so --from 2026-07-01 --to 2026-08-01 is exactly July. Either bound may
be given on its own. \`trend\` uses --days instead.

Everything is local. The index stores hashed IDs and token metadata only.`);
}

export function parseArgs(argv) {
  // A flag whose value is missing must fail loudly. Silently reading
  // `undefined` turned `--since` with no argument into "no time filter at all".
  const value = (argv, index, flag) => {
    if (index >= argv.length) throw new Error(`${flag} requires a value.`);
    return argv[index];
  };
  const args = {
    command: argv[0] === "--help" || argv[0] === "-h" ? "report" : (argv[0] || "report"),
    positional: [],
    json: false,
    fresh: false,
    since: null,
    from: null,
    to: null,
    olderThan: null,
    days: 7,
    limit: 20,
    port: 7474,
    logDir: process.env.AGENT_FINOPS_LOG_DIR || join(homedir(), ".claude", "projects"),
    indexPath: process.env.AGENT_FINOPS_INDEX || defaultIndexPath(),
  };
  if (argv[0] === "--help" || argv[0] === "-h") args.help = true;
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--json") args.json = true;
    else if (flag === "--fresh") args.fresh = true;
    else if (flag === "--since") args.since = value(argv, ++i, flag);
    else if (flag === "--from") args.from = value(argv, ++i, flag);
    else if (flag === "--to") args.to = value(argv, ++i, flag);
    else if (flag === "--older-than") args.olderThan = value(argv, ++i, flag);
    else if (flag === "--days") args.days = Number(value(argv, ++i, flag));
    else if (flag === "--limit") args.limit = Number(value(argv, ++i, flag));
    else if (flag === "--port") args.port = Number(value(argv, ++i, flag));
    else if (flag === "--log-dir") args.logDir = value(argv, ++i, flag);
    else if (flag === "--index") args.indexPath = value(argv, ++i, flag);
    else if (flag === "--help" || flag === "-h") args.help = true;
    else args.positional.push(flag);
  }
  return args;
}

export function listLimit(value) {
  if (!Number.isInteger(value) || value < 1 || value > 10_000) throw new Error("--limit must be an integer between 1 and 10000.");
  return value;
}

export function sinceToMs(value) {
  if (!value) return null;
  const match = /^(\d+)([dhw])$/.exec(value);
  if (!match) throw new Error(`Invalid --since value ${value}; use 24h, 7d, or 2w.`);
  return Date.now() - Number(match[1]) * { d: 86_400_000, h: 3_600_000, w: 604_800_000 }[match[2]];
}

// A calendar date, or a full ISO-8601 timestamp. A bare date is read as UTC
// midnight because day buckets are UTC everywhere else in this tool; reading it
// as local midnight would shift a "month" by a few hours at both ends.
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?$/;

export function boundaryToMs(value, flag) {
  if (!value) return null;
  if (typeof value !== "string" || !(DATE_ONLY_RE.test(value) || ISO_TIMESTAMP_RE.test(value))) {
    throw new Error(`Invalid ${flag} value ${value}; use a date such as 2026-07-01 (UTC midnight) or a full ISO-8601 timestamp such as 2026-07-01T09:30:00Z.`);
  }
  const time = Date.parse(DATE_ONLY_RE.test(value) ? `${value}T00:00:00Z` : value);
  // The calendar date is re-checked by round trip because `Date.parse` falls
  // back to a lenient parser that rolls an impossible day over: 2026-02-30
  // becomes March 2 and the requested window silently moves.
  const [date] = value.split("T");
  if (!Number.isFinite(time) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw new Error(`Invalid ${flag} value ${value}; that is not a real date.`);
  }
  return time;
}

/**
 * Resolve the reporting window. `--since` is relative to now and `--from`/`--to`
 * are absolute, and mixing them cannot mean anything sensible — silently letting
 * one win would produce a window the user did not ask for, which is exactly the
 * failure this flag pair exists to remove. The window is `[from, to)`, so
 * `--from 2026-07-01 --to 2026-08-01` is July and nothing else.
 */
export function timeWindow({ since = null, from = null, to = null } = {}) {
  if (since && (from || to)) throw new Error("--since sets a window relative to now and --from/--to set an absolute one; use one or the other, not both.");
  if (since) return { sinceMs: sinceToMs(since), untilMs: null };
  return { sinceMs: boundaryToMs(from, "--from"), untilMs: boundaryToMs(to, "--to") };
}

export function durationToMs(value, flag) {
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

// The index is loaded before the walk, not after it: session and project ids are
// salted with the salt stored inside it, so the salt has to exist before a single
// path is fingerprinted.
async function scan(args, index = loadIndex(args.indexPath)) {
  const files = findClaudeJsonl(args.logDir, index.salt);
  if (!files.length) throw new Error(`No Claude Code JSONL logs found under ${args.logDir}`);
  const updated = await updateIndex(index, files);
  saveIndex(args.indexPath, updated.index);
  return updated;
}

/**
 * Project ids are salted per install, so a labels file written before this
 * version — or copied from another machine — names ids that no current project
 * has. Say so once rather than showing bare ids forever with no explanation.
 */
function staleLabelNotice(records) {
  const labels = loadLabels();
  const ids = Object.keys(labels);
  if (!ids.length) return null;
  const current = new Set(records.map((record) => record.project).filter(Boolean));
  if (ids.some((id) => current.has(id))) return null;
  return `Note: ${ids.length} local project label(s) match no current project id. Project ids are salted per install; re-run \`agent-finops projects\` and re-apply labels with \`agent-finops label\`.`;
}

/**
 * Age of an index in milliseconds. An absent or unparseable timestamp counts as
 * infinitely old, so a malformed index is rescanned rather than trusted.
 */
function indexAgeMs(index) {
  const scannedAt = Date.parse(index.scannedAt || "");
  return Number.isFinite(scannedAt) ? Date.now() - scannedAt : Infinity;
}

/**
 * Load the index a reporting command will read, rescanning when it has aged
 * out. Kept separate from report building so a command aggregates the corpus
 * exactly once, with its own limits, instead of discarding a default report.
 */
async function indexFor(args) {
  let index = loadIndex(args.indexPath);
  let scanStats = null;
  // Rescan once the index ages out, not just when it is missing. `updateIndex`
  // reuses every file whose mtime and size are unchanged, so the steady-state
  // cost is a stat() per log, and a spend figure is never quietly served from a
  // stale snapshot that reads exactly like "you have no usage".
  if (args.fresh || indexAgeMs(index) > INDEX_MAX_AGE_MS) {
    const updated = await scan(args, index);
    index = updated.index;
    scanStats = updated.stats;
  }
  return { index, scanStats };
}

/**
 * Optional context for the recommendation rules: what the local output filter
 * has removed, and how this week compares with the one before it. Both are
 * best-effort. The filter ledger only exists once the PostToolUse hook has run,
 * and a trend needs history the index may not hold yet — neither absence is an
 * error, and neither may take a report down with it.
 */
function hotspotExtras(records, sinceMs) {
  const extras = {};
  try { extras.filterStats = filterReport({ sinceMs }); } catch { /* no filter ledger yet */ }
  try { extras.trend = analyzeTrend(records, { days: 7 }); } catch { /* not enough history */ }
  return extras;
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
      const output = { scannedAt: updated.index.scannedAt, records: updated.records.length, ...updated.stats };
      if (args.json) console.log(JSON.stringify(output, null, 2));
      else {
        console.log(`Indexed ${output.records.toLocaleString()} metadata records · ${output.filesParsed} files parsed · ${output.filesAppended} appended · ${output.filesReused} reused · ${output.filesRetired} retired · ${output.parseErrors} parse errors`);
        // A log file Claude Code deleted is retired, not dropped, so its spend
        // stays in every report. Saying how many were retired is what makes that
        // visible instead of looking like an unexplained record count.
        if (output.filesRetired) console.log(`${output.filesRetired} log file(s) are gone from disk; their metadata records were retained. Bound that history with \`agent-finops prune-index --older-than 90d\`.`);
        const stale = staleLabelNotice(updated.records);
        if (stale) console.log(stale);
      }
      return;
    }
    if (args.command === "prune-index") {
      const olderThanMs = durationToMs(args.olderThan, "--older-than");
      const index = loadIndex(args.indexPath);
      const removed = pruneRetired(index, { olderThanMs });
      // Only rewrite the index when something actually changed: this command is
      // reachable before a first scan, and it must not create an index of its own.
      if (removed.removedRecords) saveIndex(args.indexPath, index);
      console.log(args.json
        ? JSON.stringify(removed, null, 2)
        : `Removed ${removed.removedRecords.toLocaleString()} retired metadata record(s) and ${removed.removedSources} emptied session(s) older than ${removed.cutoff}. ${removed.remainingRecords.toLocaleString()} retired record(s) remain across ${removed.remainingSources} session(s). Live log files are untouched.`);
      return;
    }
    if (args.command === "compare") {
      const [leftName, rightName] = args.positional;
      const index = loadIndex(args.indexPath);
      if (!leftName || !rightName) throw new Error("compare requires BASELINE and EXPERIMENT tag names.");
      // `Object.hasOwn`, not truthiness: a tag name is user input, and
      // `tags["constructor"]` would otherwise resolve to an inherited value and
      // be compared as if it were a snapshot.
      if (!Object.hasOwn(index.tags, leftName) || !Object.hasOwn(index.tags, rightName)) throw new Error("Both comparison tags must exist. Run `agent-finops tag NAME --since 24h` first.");
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
    // Resolved before the index is touched so a malformed window fails fast
    // rather than after a scan.
    const { sinceMs, untilMs } = timeWindow(args);
    const { index, scanStats } = await indexFor(args);
    const records = indexedRecords(index);
    // One report per command. Deliberately no index path in the decoration:
    // `report --json` is the artifact people share, and an absolute path
    // carries the local username. `doctor` prints paths.
    const reportWith = (options = {}) => {
      const built = buildReport(records, { sinceMs, untilMs, ...options });
      built.index = { scannedAt: index.scannedAt || null, scanStats };
      return built;
    };
    if (args.command === "dashboard") {
      // The scan timestamp travels onto the page so an index that predates the
      // window is legible as a stale read rather than as an empty month.
      const dashboardReport = reportWith({ sessionLimit: 12, toolLimit: 12, projectLimit: 12 });
      // Local project labels are the user's own names for anonymous ids. They
      // carry no path, so they can name a row on the page instead of a
      // fingerprint nobody can place.
      const extras = hotspotExtras(records, sinceMs);
      const analysis = hotspotAnalysis(dashboardReport, extras);
      // The page's "what changed" section reads the same trend the hotspot rules
      // do, so the two cannot describe different windows. That trend is the
      // fixed 7-day pair, deliberately not derived from `--since`: a comparison
      // whose length changed with the view would mean something different every
      // time it was opened, and only the two most recent complete weeks answer
      // "what changed" regardless of how much history is on screen. The section
      // states the windows it used. `extras.trend` is absent when the index
      // holds too little history, and the section says so rather than vanishing.
      const running = await startDashboard(dashboardReport, analysis, { port: args.port, labels: loadLabels(), trend: extras.trend || null });
      console.log(`Dashboard running at ${running.url}`);
      console.log("Loopback only. Press Ctrl-C to stop.");
      await new Promise((resolve) => running.server.once("close", resolve));
      return;
    }
    if (args.command === "report") {
      const report = reportWith();
      if (args.json) {
        // `--json` is the artifact people share, and a label is the user's own
        // name for a workspace: neither it nor the trend enters the shared shape.
        console.log(JSON.stringify(report, null, 2));
        return;
      }
      // Best-effort context, exactly as it is for the hotspot rules: a trend
      // needs history the index may not hold, and no report may fail because one
      // could not be built. Computed only for the terminal view, since it costs
      // two more passes over the corpus and `--json` never reads it.
      let trend = null;
      try { trend = analyzeTrend(records, { days: 7 }); } catch { /* not enough history */ }
      // Local project labels name the anonymous ids in the terminal view only.
      console.log(humanReport(report, loadLabels(), trend));
      return;
    }
    if (args.command === "hotspots") {
      const report = reportWith();
      const analysis = hotspotAnalysis(report, hotspotExtras(records, sinceMs));
      console.log(args.json ? JSON.stringify({ report, analysis }, null, 2) : humanHotspots(analysis));
      return;
    }
    if (args.command === "sessions") {
      const sessionReport = buildReport(records, { sinceMs, untilMs, sessionLimit: listLimit(args.limit) });
      console.log(args.json ? JSON.stringify(sessionReport.topSessions, null, 2) : humanSessions(sessionReport.topSessions, loadLabels()));
      return;
    }
    if (args.command === "session") {
      const [id] = args.positional;
      if (!id) throw new Error("session requires a session ID printed by `agent-finops sessions`.");
      const sessionReport = buildReport(records.filter((record) => record.source === id), { sinceMs, untilMs, toolLimit: listLimit(args.limit) });
      if (!sessionReport.scope.recordsAfterDateFilter) throw new Error(`No usage records found for session ${id} in this period.`);
      console.log(args.json ? JSON.stringify(sessionReport, null, 2) : humanReport(sessionReport, loadLabels()));
      return;
    }
    if (args.command === "compare-sessions") {
      const [leftId, rightId] = args.positional;
      if (!leftId || !rightId) throw new Error("compare-sessions requires two IDs printed by `agent-finops sessions`.");
      const options = { sinceMs, untilMs, toolLimit: listLimit(args.limit) };
      const left = buildReport(records.filter((record) => record.source === leftId), options);
      const right = buildReport(records.filter((record) => record.source === rightId), options);
      if (!left.scope.recordsAfterDateFilter || !right.scope.recordsAfterDateFilter) throw new Error("One or both sessions have no usage records in this period.");
      const comparison = compareSnapshots(leftId, left, rightId, right);
      console.log(args.json ? JSON.stringify(comparison, null, 2) : humanComparison(comparison));
      return;
    }
    if (args.command === "tools" || args.command === "mcp") {
      const toolReport = buildReport(records, { sinceMs, untilMs, toolLimit: Number.MAX_SAFE_INTEGER });
      const rows = args.command === "mcp" ? toolReport.topTools.filter((tool) => tool.name.startsWith("mcp__")) : toolReport.topTools;
      const output = rows.slice(0, listLimit(args.limit));
      console.log(args.json ? JSON.stringify(output, null, 2) : humanTools(output, { onlyMcp: args.command === "mcp" }));
      return;
    }
    if (args.command === "projects") {
      const labels = loadLabels();
      const projectReport = buildReport(records, { sinceMs, untilMs, projectLimit: listLimit(args.limit) });
      const output = projects(projectReport, labels);
      if (args.json) console.log(JSON.stringify(output, null, 2));
      else console.log(["Projects:", ...output.map((item) => `  ${displayProject(item.id, labels).padEnd(28)} $${item.usd.toFixed(2)}  ${Math.round(item.tokens).toLocaleString()} tokens  ${item.requests} turns`), "", "Project paths are never stored or printed. Use `agent-finops label PROJECT_ID \"Name\"` to label an id locally."].join("\n"));
      return;
    }
    if (args.command === "project") {
      const [id] = args.positional;
      if (!id) throw new Error("project requires a project ID printed by `agent-finops projects`.");
      const projectReport = buildReport(records.filter((record) => record.project === id), { sinceMs, untilMs, toolLimit: listLimit(args.limit) });
      if (!projectReport.scope.recordsAfterDateFilter) throw new Error(`No usage records found for project ${id} in this period.`);
      // The label is a local name for the id, so it heads the report rather than
      // entering it: the JSON body is the artifact people share.
      const projectLabels = loadLabels();
      console.log(args.json ? JSON.stringify(projectReport, null, 2) : `Project: ${displayProject(id, projectLabels)}\n${humanReport(projectReport, projectLabels)}`);
      return;
    }
    if (args.command === "trend") {
      const trend = analyzeTrend(records, { days: args.days });
      console.log(args.json ? JSON.stringify(trend, null, 2) : humanTrend(trend));
      return;
    }
    if (args.command === "tag") {
      const [name] = args.positional;
      if (!name) throw new Error("tag requires a name, for example `agent-finops tag baseline-24h --since 24h`.");
      const tag = saveTag(index, name, reportWith());
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

/**
 * True when this file is the process entry point. The argument and duration
 * helpers above are exported so they can be unit tested, which means importing
 * this module must not run a command. `realpathSync` is what makes that safe
 * with `scripts/install-local.sh`: it puts a symlink on PATH, and Node reports
 * the resolved real path as the module URL.
 */
function isEntryPoint() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntryPoint()) main();
