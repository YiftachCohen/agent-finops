// Deterministic, local Bash-output reduction for Claude Code PostToolUse hooks.
// The raw result is retained only when this opt-in feature is active; the normal
// accounting index never contains output text.

import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const MAX_CHARS = 12_000;
const HEAD_LINES = 60;
const TAIL_LINES = 60;
const IMPORTANT_LINES = 40;
const TAIL_CHAR_SHARE = 0.4;
const SIGNAL_RE = /\b(error|errors|fail|failed|failure|fatal|warning|warn|exception|traceback|assert|expected|actual)\b/i;

function hash(value) {
  return createHash("sha256").update(value || "").digest("hex").slice(0, 12);
}

export function filterHome() {
  return process.env.AGENT_FINOPS_FILTER_DIR || join(homedir(), ".local", "share", "agent-finops", "filter");
}

function artifactDir(home = filterHome()) { return join(home, "artifacts"); }
function ledgerPath(home = filterHome()) { return join(home, "history.jsonl"); }

function conciseLines(stdout) {
  const lines = stdout.split("\n");
  const deduped = [];
  let droppedDuplicates = 0;
  for (const line of lines) {
    if (line === deduped.at(-1)) droppedDuplicates++;
    else deduped.push(line);
  }
  if (deduped.length <= HEAD_LINES + TAIL_LINES + IMPORTANT_LINES) return { lines: deduped, droppedDuplicates, elided: 0 };
  const head = deduped.slice(0, HEAD_LINES);
  const tail = deduped.slice(-TAIL_LINES);
  const important = deduped.slice(HEAD_LINES, -TAIL_LINES).filter((line) => SIGNAL_RE.test(line)).slice(0, IMPORTANT_LINES);
  // Count retained positions, not distinct strings: a Set collapses lines that
  // repeat non-adjacently and overstates how much was dropped.
  const elided = deduped.length - head.length - tail.length - important.length;
  const middle = important.length ? ["", "[agent-finops: matching diagnostic lines from omitted output]", ...important, ""] : [];
  return { lines: [...head, `\n[agent-finops: ${elided} non-diagnostic line(s) omitted]\n`, ...middle, ...tail], droppedDuplicates, elided };
}

/**
 * Fit text to a character budget by keeping both ends. Truncating only the end
 * would drop the tail of a build or test run, which is where the failure
 * summary lives, so the tail keeps a reserved share of the budget.
 */
function fitKeepingEnds(text, budget) {
  if (text.length <= budget) return text;
  const notice = "\n[agent-finops: middle truncated to fit the reduction budget]\n";
  const room = Math.max(0, budget - notice.length);
  const tailChars = Math.floor(room * TAIL_CHAR_SHARE);
  return text.slice(0, room - tailChars) + notice + text.slice(text.length - tailChars);
}

/** Compress stdout, preserving stderr externally and leaving short output exact. */
export function compactStdout(stdout) {
  if (typeof stdout !== "string" || stdout.length <= MAX_CHARS) return { stdout: stdout || "", changed: false, rawChars: (stdout || "").length, sentChars: (stdout || "").length, elidedLines: 0 };
  const result = conciseLines(stdout);
  const compacted = fitKeepingEnds(result.lines.join("\n"), MAX_CHARS);
  return { stdout: compacted, changed: compacted !== stdout, rawChars: stdout.length, sentChars: compacted.length, elidedLines: result.elided };
}

function ensurePrivate(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
}

export function retainArtifact({ stdout, stderr }, home = filterHome()) {
  const directory = artifactDir(home);
  ensurePrivate(directory);
  const id = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const path = join(directory, `${id}.json`);
  writeFileSync(path, JSON.stringify({ stdout, stderr }), { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
  return id;
}

function appendTelemetry(event, home = filterHome()) {
  ensurePrivate(home);
  const path = ledgerPath(home);
  writeFileSync(path, `${JSON.stringify(event)}\n`, { encoding: "utf8", flag: "a", mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Handle the JSON delivered by Claude Code PostToolUse for a Bash result. */
export function processPostToolUse(event, home = filterHome()) {
  const response = event?.tool_response;
  if (event?.tool_name !== "Bash" || !response || response.isImage || typeof response.stdout !== "string") return null;
  const compacted = compactStdout(response.stdout);
  if (!compacted.changed) return null;
  const artifactId = retainArtifact({ stdout: response.stdout, stderr: typeof response.stderr === "string" ? response.stderr : "" }, home);
  appendTelemetry({
    timestamp: new Date().toISOString(),
    session: hash(event.session_id),
    project: hash(event.cwd),
    artifactId,
    rawChars: compacted.rawChars,
    sentChars: compacted.sentChars,
    elidedLines: compacted.elidedLines,
  }, home);
  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      updatedToolOutput: {
        stdout: `${compacted.stdout}\n\n[agent-finops: full local output retained as ${artifactId}; retrieve with agent-finops artifact ${artifactId}]`,
        stderr: typeof response.stderr === "string" ? response.stderr : "",
        interrupted: Boolean(response.interrupted),
        isImage: false,
      },
    },
  };
}

export function readArtifact(id, home = filterHome()) {
  if (!/^[a-z0-9-]{8,80}$/i.test(id)) throw new Error("Invalid artifact id.");
  const path = join(artifactDir(home), `${id}.json`);
  if (!existsSync(path)) throw new Error(`Artifact not found: ${id}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

export function filterReport({ sinceMs = null, home = filterHome() } = {}) {
  const path = ledgerPath(home);
  if (!existsSync(path)) return { events: 0, rawChars: 0, sentChars: 0, savedChars: 0, estimatedTokensSaved: 0 };
  let events = 0;
  let rawChars = 0;
  let sentChars = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    try {
      const event = JSON.parse(line);
      const time = Date.parse(event.timestamp || "");
      if (sinceMs && (!Number.isFinite(time) || time < sinceMs)) continue;
      events++;
      rawChars += event.rawChars || 0;
      sentChars += event.sentChars || 0;
    } catch { /* tolerate a partial final line */ }
  }
  const savedChars = Math.max(0, rawChars - sentChars);
  return { events, rawChars, sentChars, savedChars, estimatedTokensSaved: Math.round(savedChars / 4) };
}

export function pruneArtifacts({ olderThanMs, home = filterHome() }) {
  if (!Number.isFinite(olderThanMs) || olderThanMs <= 0) throw new Error("Provide a positive retention duration.");
  const directory = artifactDir(home);
  let removed = 0;
  try {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const path = join(directory, entry.name);
      if (Date.now() - statSync(path).mtimeMs > olderThanMs) { unlinkSync(path); removed++; }
    }
  } catch { /* no artifact directory yet */ }
  return removed;
}

/** POSIX single-quoting. JSON quoting would leave `$` and backticks live. */
function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

export function hookConfig(cliPath) {
  return {
    hooks: {
      PostToolUse: [{
        matcher: "Bash",
        hooks: [{ type: "command", command: `node ${shellQuote(cliPath)} hook`, timeout: 10 }],
      }],
    },
  };
}
