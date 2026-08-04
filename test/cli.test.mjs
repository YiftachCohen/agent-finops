import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { boundaryToMs, durationToMs, listLimit, parseArgs, sinceToMs, timeWindow } from "../src/cli.mjs";
import { renderDashboard } from "../src/dashboard.mjs";
import { indexedRecords, loadIndex } from "../src/index.mjs";
import { buildReport } from "../src/report.mjs";
import { analyzeTrend } from "../src/trends.mjs";

const run = promisify(execFile);
const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.mjs");
const SECRET = "TOP-SECRET-EXAMPLE";
// A stand-in for the random per-install salt, so output can be searched for it.
const SALT = "SALT-MUST-NEVER-LEAVE-THE-INDEX-FILE";

function runWithStdin(args, input, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [CLI, ...args], { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test("CLI top-level help does not attempt to scan local logs", async () => {
  const result = await runWithStdin(["--help"], "", { AGENT_FINOPS_LOG_DIR: join(tmpdir(), "agent-finops-no-logs") });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^Usage:/);
  assert.equal(result.stderr, "");
});

test("CLI produces a JSON report without prompt content", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-finops-"));
  try {
    mkdirSync(join(root, "project"));
    writeFileSync(join(root, "project", "session.jsonl"), [
      `{"type":"user","message":{"content":"${SECRET}"}}`,
      `{"type":"assistant","requestId":"r1","timestamp":"2026-08-01T10:00:00Z","message":{"id":"m1","model":"claude-sonnet-4-6","content":"${SECRET}","usage":{"input_tokens":10,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":5}}}`,
    ].join("\n"));
    const index = join(root, "index.json");
    const { stdout } = await run("node", [CLI, "report", "--json", "--log-dir", root, "--index", index, "--fresh"]);
    assert.ok(!stdout.includes(SECRET));
    const result = JSON.parse(stdout);
    assert.equal(result.total.usage.total, 15);
    assert.equal(result.index.scanStats.filesSeen, 1);
    assert.deepEqual(Object.keys(result.diagnostics).sort(), ["duplicatesDropped", "missingIds"], "no per-turn record list in shared JSON");
    // This JSON is the artifact people share; an absolute path would carry the
    // local username. `doctor` is where paths are printed.
    assert.ok(!stdout.includes(root), "no log-dir path");
    assert.ok(!stdout.includes(index), "no index path");
    assert.ok(!/\/(Users|home)\//.test(stdout), "no home-directory path");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("project names are an opt-in live display and never enter the index or JSON", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-finops-reveal-project-"));
  const project = "client-private-dashboard";
  try {
    mkdirSync(join(root, project));
    const index = join(root, "index.json");
    writeFileSync(join(root, project, "session.jsonl"), `{"type":"assistant","requestId":"r1","timestamp":"2026-08-01T10:00:00Z","message":{"id":"m1","model":"claude-sonnet-4-6","usage":{"input_tokens":10,"output_tokens":5}}}`);
    const shared = ["--log-dir", root, "--index", index, "--fresh"];

    const normal = (await run("node", [CLI, "projects", ...shared])).stdout;
    assert.ok(!normal.includes(project));

    const revealed = (await run("node", [CLI, "projects", "--show-project-names", ...shared])).stdout;
    assert.match(revealed, new RegExp(project));
    assert.match(revealed, /not stored/);
    const report = (await run("node", [CLI, "report", "--show-project-names", ...shared])).stdout;
    assert.match(report, new RegExp(project));
    assert.doesNotMatch(report, /Project paths are never stored or printed/);
    assert.ok(!readFileSync(index, "utf8").includes(project), "the source identifier must not cross into the index");

    const rejected = await runWithStdin(["projects", "--show-project-names", "--json", ...shared], "");
    assert.equal(rejected.code, 1);
    assert.match(rejected.stderr, /unavailable with --json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("report names what changed between the last two weeks, and --json is unaffected", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-finops-changed-"));
  try {
    mkdirSync(join(root, "project"));
    const index = join(root, "index.json");
    // Relative to now, because the trend windows are the last seven *complete*
    // UTC days and the seven before them. A day inside each window is all this
    // needs, and a fixed date would rot the moment the calendar passed it.
    const daysAgo = (days) => new Date(Date.now() - days * 86_400_000).toISOString();
    const turn = (id, model, days, output) => JSON.stringify({
      type: "assistant",
      requestId: id,
      timestamp: daysAgo(days),
      message: { id, model, content: SECRET, usage: { input_tokens: 0, output_tokens: output } },
    });
    writeFileSync(join(root, "project", "session.jsonl"), [
      // $15 + $5 previous week, $45 + $1 this week: sonnet rose $30, haiku fell $4.
      turn("r1", "claude-sonnet-4-6", 8, 1e6),
      turn("r2", "claude-haiku-4-5", 8, 1e6),
      turn("r3", "claude-sonnet-4-6", 1, 3e6),
      turn("r4", "claude-haiku-4-5", 1, 2e5),
    ].join("\n"));

    const { stdout } = await run("node", [CLI, "report", "--log-dir", root, "--index", index, "--fresh"]);
    const lines = stdout.split("\n");
    assert.equal(lines[lines.findIndex((row) => row.startsWith("What changed:")) - 1].startsWith("Run rate:"), true);
    assert.match(stdout, /What changed: last 7 days vs previous 7 · \$20\.00 → \$46\.00 \(130\.0%\)\n/);
    assert.match(stdout, /\n {2}model {4}claude-sonnet-4-6 {12}\+\$30\.00\n/);
    assert.match(stdout, /\n {2}model {4}claude-haiku-4-5 {13}-\$4\.00\n/);
    // One project directory, so both models moved the same project by $26 net.
    assert.match(stdout, /\n {2}project {2}[a-f0-9]{12} {17}\+\$26\.00\n/);
    assert.match(stdout, /not why it moved/);
    assert.ok(!stdout.includes(SECRET));

    // The shared artifact is untouched: no trend, no block, and no new key.
    const json = (await run("node", [CLI, "report", "--json", "--log-dir", root, "--index", index])).stdout;
    assert.ok(!json.includes("What changed"));
    assert.ok(!json.includes("changed"));
    assert.equal(JSON.parse(json).total.requests, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an aged-out index is rescanned without --fresh, so stale spend never reads as no usage", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-finops-stale-"));
  try {
    mkdirSync(join(root, "project"));
    const index = join(root, "index.json");
    const line = (id, output) => `{"type":"assistant","requestId":"${id}","timestamp":"2026-08-01T10:00:00Z","message":{"id":"${id}","model":"claude-sonnet-4-6","usage":{"input_tokens":10,"output_tokens":${output}}}}`;
    writeFileSync(join(root, "project", "session.jsonl"), line("r1", 5));
    await run("node", [CLI, "scan", "--log-dir", root, "--index", index]);

    // Age the index past the refresh threshold and grow the log behind it.
    const aged = JSON.parse(readFileSync(index, "utf8"));
    aged.scannedAt = new Date(Date.parse(aged.scannedAt) - 3 * 3_600_000).toISOString();
    writeFileSync(index, JSON.stringify(aged));
    writeFileSync(join(root, "project", "session.jsonl"), [line("r1", 5), line("r2", 25)].join("\n"));

    const stale = JSON.parse((await run("node", [CLI, "report", "--json", "--log-dir", root, "--index", index])).stdout);
    assert.ok(stale.index.scanStats, "an aged-out index should rescan on its own");
    assert.equal(stale.total.usage.total, 50);

    // The refreshed index is inside the window, so the next read reuses it.
    const reused = JSON.parse((await run("node", [CLI, "report", "--json", "--log-dir", root, "--index", index])).stdout);
    assert.equal(reused.index.scanStats, null, "a recent index should not be rescanned");
    assert.equal(reused.total.usage.total, 50);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI tags and compares private metadata snapshots", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-finops-tags-"));
  try {
    mkdirSync(join(root, "project"));
    const log = join(root, "project", "session.jsonl");
    const index = join(root, "index.json");
    writeFileSync(log, `{"type":"assistant","requestId":"r1","timestamp":"2026-08-01T10:00:00Z","message":{"id":"m1","model":"claude-sonnet-4-6","content":"${SECRET}","usage":{"input_tokens":10,"output_tokens":5}}}`);
    await run("node", [CLI, "tag", "baseline", "--log-dir", root, "--index", index, "--fresh"]);
    writeFileSync(log, `{"type":"assistant","requestId":"r2","timestamp":"2026-08-01T11:00:00Z","message":{"id":"m2","model":"claude-sonnet-4-6","content":"${SECRET}","usage":{"input_tokens":10,"output_tokens":20}}}`);
    await run("node", [CLI, "tag", "experiment", "--log-dir", root, "--index", index, "--fresh"]);
    const { stdout } = await run("node", [CLI, "compare", "baseline", "experiment", "--index", index]);
    assert.match(stdout, /baseline → experiment/);
    assert.ok(!stdout.includes(SECRET));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI reports MCP follow-on cohorts and directly compares anonymous sessions", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-finops-mcp-cli-"));
  try {
    mkdirSync(join(root, "project"));
    const index = join(root, "index.json");
    writeFileSync(join(root, "project", "first.jsonl"), [
      JSON.stringify({ type: "assistant", requestId: "r1", timestamp: "2026-08-01T10:00:00Z", message: { id: "m1", model: "claude-sonnet-4-6", content: [{ type: "tool_use", id: "call-1", name: "mcp__issues__search", input: { query: SECRET } }], usage: { input_tokens: 2, output_tokens: 3 } } }),
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: SECRET }] } }),
      JSON.stringify({ type: "assistant", requestId: "r2", timestamp: "2026-08-01T10:01:00Z", message: { id: "m2", model: "claude-sonnet-4-6", content: SECRET, usage: { input_tokens: 100, output_tokens: 20 } } }),
    ].join("\n"));
    writeFileSync(join(root, "project", "second.jsonl"), JSON.stringify({ type: "assistant", requestId: "r3", timestamp: "2026-08-01T10:02:00Z", message: { id: "m3", model: "claude-sonnet-4-6", content: SECRET, usage: { input_tokens: 5, output_tokens: 5 } } }));
    await run("node", [CLI, "scan", "--log-dir", root, "--index", index]);

    const mcp = JSON.parse((await run("node", [CLI, "mcp", "--json", "--index", index])).stdout);
    assert.equal(mcp.length, 1);
    assert.equal(mcp[0].name, "mcp__issues__search");
    assert.equal(mcp[0].followOnRequests, 1);

    const sessions = JSON.parse((await run("node", [CLI, "sessions", "--json", "--index", index])).stdout);
    assert.equal(sessions.length, 2);
    const detail = await run("node", [CLI, "session", sessions[0].id, "--index", index]);
    assert.match(detail.stdout, /local-only estimate/);
    const comparison = await run("node", [CLI, "compare-sessions", sessions[0].id, sessions[1].id, "--index", index]);
    assert.match(comparison.stdout, /compare:/);
    assert.ok(!`${mcp}${detail.stdout}${comparison.stdout}`.includes(SECRET));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the project command reports one project by its local id and refuses an unknown one", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-finops-project-cli-"));
  const labelsFile = join(root, "labels.json");
  try {
    mkdirSync(join(root, "alpha"));
    mkdirSync(join(root, "beta"));
    const index = join(root, "index.json");
    const turn = (id, output) => JSON.stringify({ type: "assistant", requestId: id, timestamp: "2026-08-01T10:00:00Z", message: { id, model: "claude-sonnet-4-6", content: SECRET, usage: { input_tokens: 1000, cache_read_input_tokens: 2000, output_tokens: output } } });
    writeFileSync(join(root, "alpha", "session.jsonl"), [turn("r1", 40_000), turn("r2", 40_000)].join("\n"));
    writeFileSync(join(root, "beta", "session.jsonl"), turn("r3", 1));
    const env = { ...process.env, AGENT_FINOPS_LABELS: labelsFile };
    const shared = ["--log-dir", root, "--index", index];
    await run("node", [CLI, "scan", ...shared], { env });

    const list = JSON.parse((await run("node", [CLI, "projects", "--json", ...shared], { env })).stdout);
    assert.equal(list.length, 2);
    const [top] = list;
    await run("node", [CLI, "label", top.id, "Payments API"], { env });

    const detail = await run("node", [CLI, "project", top.id, ...shared], { env });
    // The label heads the report; the report body stays the shareable artifact.
    assert.match(detail.stdout, /^Project: Payments API \([0-9a-f]{12}\)\n/);
    assert.match(detail.stdout, /local-only estimate/);
    assert.match(detail.stdout, /Cost by class: /);
    assert.ok(!detail.stdout.includes(SECRET));

    const scoped = JSON.parse((await run("node", [CLI, "project", top.id, "--json", ...shared], { env })).stdout);
    assert.equal(scoped.total.requests, 2, "only this project's turns are counted");
    assert.equal(scoped.topProjects.length, 1);
    assert.equal(scoped.topProjects[0].id, top.id);
    assert.ok(Math.abs(scoped.total.usd - top.usd) < 1e-9);
    assert.ok(!JSON.stringify(scoped).includes(SECRET));

    // An id nobody used is an error, not an empty report that reads as $0 spent.
    const missing = await runWithStdin(["project", "ffffffffffff", ...shared], "", { AGENT_FINOPS_LABELS: labelsFile });
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /No usage records found for project ffffffffffff/);
    const bare = await runWithStdin(["project", ...shared], "", { AGENT_FINOPS_LABELS: labelsFile });
    assert.equal(bare.code, 1);
    assert.match(bare.stderr, /project requires a project ID/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hook command reads stdin and returns a valid PostToolUse replacement", async () => {
  const filterDir = mkdtempSync(join(tmpdir(), "agent-finops-hook-cli-"));
  try {
    const event = {
      tool_name: "Bash",
      session_id: "s",
      cwd: "/project",
      tool_response: { stdout: Array.from({ length: 700 }, (_, i) => `line ${i} ${"x".repeat(30)}`).join("\n"), stderr: "", interrupted: false, isImage: false },
    };
    const result = await runWithStdin(["hook"], JSON.stringify(event), { AGENT_FINOPS_FILTER_DIR: filterDir });
    assert.equal(result.code, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, "PostToolUse");
    assert.ok(output.hookSpecificOutput.updatedToolOutput.stdout.length < event.tool_response.stdout.length);
  } finally {
    rmSync(filterDir, { recursive: true, force: true });
  }
});

test("hotspots reads the filter ledger and the trend, and survives having neither", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-finops-extras-"));
  const filterDir = mkdtempSync(join(tmpdir(), "agent-finops-extras-filter-"));
  try {
    mkdirSync(join(root, "project"));
    const index = join(root, "index.json");
    // Relative to now, because the trend windows are: three days ago is inside
    // the current 7-day window and ten days ago is inside the previous one.
    const daysAgo = (offset) => new Date(Date.now() - offset * 86_400_000).toISOString();
    const turn = (id, timestamp, output, content) => JSON.stringify({
      type: "assistant",
      requestId: id,
      timestamp,
      message: { id, model: "claude-sonnet-4-6", content: content ?? SECRET, usage: { input_tokens: 10, output_tokens: output } },
    });
    writeFileSync(join(root, "project", "session.jsonl"), [
      turn("r1", daysAgo(3), 5, [{ type: "tool_use", id: "call-1", name: "Bash", input: { command: SECRET } }]),
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: SECRET }] } }),
      // Sonnet 4.6 bills output at $15/M, so this follow-on turn is $45 and it is
      // attributed to the single Bash call that preceded it.
      turn("r2", daysAgo(3), 3e6),
      turn("r3", daysAgo(10), 1e6),
    ].join("\n"));

    const shared = ["--log-dir", root, "--index", index, "--fresh"];
    // No ledger and no artifacts: the recommendation still lands, with nothing
    // measured attached to it.
    const bare = JSON.parse((await run("node", [CLI, "hotspots", "--json", ...shared], { env: { ...process.env, AGENT_FINOPS_FILTER_DIR: join(filterDir, "absent") } })).stdout);
    const bareKinds = bare.analysis.recommendations.map((item) => item.kind);
    assert.ok(bareKinds.includes("bash-output-filter"), "an expensive Bash cohort should point at the filter");
    assert.ok(bareKinds.includes("spend-acceleration"), "a window up 200% on the previous one should be called out");
    const bareBash = bare.analysis.recommendations.find((item) => item.kind === "bash-output-filter");
    assert.ok(!bareBash.evidence.includes("already removed"), "nothing was measured, so nothing is claimed");
    const acceleration = bare.analysis.recommendations.find((item) => item.kind === "spend-acceleration");
    assert.match(acceleration.evidence, /largest model-level change is claude-sonnet-4-6/);

    // The same run with a ledger the hook has actually written quotes it.
    writeFileSync(join(filterDir, "history.jsonl"), [
      JSON.stringify({ timestamp: daysAgo(2), session: "aaaa", project: "bbbb", artifactId: "x", rawChars: 500_000, sentChars: 100_000, elidedLines: 400 }),
      JSON.stringify({ timestamp: daysAgo(1), session: "aaaa", project: "bbbb", artifactId: "y", rawChars: 300_000, sentChars: 100_000, elidedLines: 200 }),
    ].join("\n"));
    const measured = JSON.parse((await run("node", [CLI, "hotspots", "--json", ...shared], { env: { ...process.env, AGENT_FINOPS_FILTER_DIR: filterDir } })).stdout);
    const measuredBash = measured.analysis.recommendations.find((item) => item.kind === "bash-output-filter");
    assert.match(measuredBash.evidence, /already removed ~150,000 input tokens across 2 filtered result\(s\)/);

    // Neither extra may put prompt content or a path into the shared artifact.
    for (const payload of [JSON.stringify(bare), JSON.stringify(measured)]) {
      assert.ok(!payload.includes(SECRET), "hotspots leaked prompt content");
      assert.ok(!payload.includes(root), "hotspots leaked a log path");
      assert.ok(!payload.includes(filterDir), "hotspots leaked the filter path");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(filterDir, { recursive: true, force: true });
  }
});

test("duration and limit flags are parsed strictly, and a flag without a value fails", () => {
  // A flag whose value is missing used to read `undefined`, which silently
  // turned `--since` into "no time filter at all" — the opposite of the ask.
  assert.throws(() => parseArgs(["report", "--since"]), /--since requires a value\./);
  assert.throws(() => parseArgs(["prune", "--older-than"]), /--older-than requires a value\./);
  assert.throws(() => parseArgs(["report", "--index"]), /--index requires a value\./);
  assert.equal(parseArgs(["report", "--since", "7d"]).since, "7d");
  // A value that looks like a flag is still consumed as the value; the parser
  // must not skip it and leave the flag unset.
  assert.equal(parseArgs(["report", "--since", "--json"]).since, "--json");

  assert.equal(sinceToMs(null), null);
  const day = sinceToMs("1d");
  assert.ok(Math.abs(Date.now() - day - 86_400_000) < 5_000);
  assert.ok(Math.abs(Date.now() - sinceToMs("2w") - 1_209_600_000) < 5_000);
  for (const bad of ["7", "d", "7 d", "-1d", "7m", "7dd", "1e3d", "24H"]) {
    assert.throws(() => sinceToMs(bad), /Invalid --since value/, bad);
  }

  assert.equal(durationToMs("24h", "--older-than"), 3_600_000 * 24);
  assert.throws(() => durationToMs(null, "--older-than"), /--older-than requires a duration/);
  assert.throws(() => durationToMs("forever", "--older-than"), /Invalid --older-than value/);

  assert.equal(listLimit(20), 20);
  for (const bad of [0, -1, 1.5, 10_001, Number.NaN, Infinity, "20"]) {
    assert.throws(() => listLimit(bad), /--limit must be an integer between 1 and 10000\./, String(bad));
  }
});

test("an absolute window is parsed strictly and never silently overrides --since", () => {
  assert.equal(parseArgs(["report", "--from", "2026-07-01"]).from, "2026-07-01");
  assert.equal(parseArgs(["report", "--to", "2026-08-01"]).to, "2026-08-01");
  assert.throws(() => parseArgs(["report", "--from"]), /--from requires a value\./);
  assert.throws(() => parseArgs(["report", "--to"]), /--to requires a value\./);

  // A bare date is UTC midnight: day buckets are UTC everywhere else, and a
  // local-midnight window would be shifted by hours at both ends.
  assert.equal(boundaryToMs("2026-07-01", "--from"), Date.parse("2026-07-01T00:00:00Z"));
  assert.equal(boundaryToMs("2026-07-01T09:30:00Z", "--from"), Date.parse("2026-07-01T09:30:00Z"));
  assert.equal(boundaryToMs("2026-07-01T09:30:00+02:00", "--from"), Date.parse("2026-07-01T07:30:00Z"));
  assert.equal(boundaryToMs(null, "--from"), null);
  for (const bad of ["7d", "2026-7-1", "2026-07-01 09:30", "July 1", "2026", "now", "2026-07-01T09", "2026-13-01", "2026-02-30"]) {
    assert.throws(() => boundaryToMs(bad, "--from"), /Invalid --from value/, bad);
  }

  // Precedence would hand back a window nobody asked for; this pair exists
  // precisely so the requested window is unambiguous.
  assert.throws(() => timeWindow({ since: "7d", from: "2026-07-01" }), /use one or the other/);
  assert.throws(() => timeWindow({ since: "7d", to: "2026-08-01" }), /use one or the other/);
  assert.deepEqual(timeWindow({ from: "2026-07-01", to: "2026-08-01" }), { sinceMs: Date.parse("2026-07-01T00:00:00Z"), untilMs: Date.parse("2026-08-01T00:00:00Z") });
  assert.deepEqual(timeWindow({ to: "2026-08-01" }), { sinceMs: null, untilMs: Date.parse("2026-08-01T00:00:00Z") });
  assert.deepEqual(timeWindow({}), { sinceMs: null, untilMs: null });
  assert.equal(timeWindow({ since: "1d" }).untilMs, null);
});

test("--from/--to filter an exact calendar month, and a tag remembers the window it took", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-finops-window-"));
  try {
    mkdirSync(join(root, "project"));
    const index = join(root, "index.json");
    const turn = (id, timestamp, output) => JSON.stringify({ type: "assistant", requestId: id, timestamp, message: { id, model: "claude-sonnet-4-6", content: SECRET, usage: { input_tokens: 10, output_tokens: output } } });
    writeFileSync(join(root, "project", "session.jsonl"), [
      turn("june", "2026-06-30T23:59:59Z", 100),
      turn("july-open", "2026-07-01T00:00:00Z", 1),
      turn("july-mid", "2026-07-20T12:00:00Z", 2),
      turn("august", "2026-08-01T00:00:00Z", 400),
    ].join("\n"));
    const shared = ["--log-dir", root, "--index", index];
    const july = JSON.parse((await run("node", [CLI, "report", "--json", "--from", "2026-07-01", "--to", "2026-08-01", ...shared, "--fresh"])).stdout);
    assert.equal(july.total.requests, 2, "the turn at 2026-07-01T00:00:00Z is in, the one at 2026-08-01T00:00:00Z is out");
    assert.equal(july.total.usage.output, 3);
    assert.deepEqual(Object.keys(july.byDay), ["2026-07-01", "2026-07-20"]);
    assert.equal(july.scope.untilMs, Date.parse("2026-08-01T00:00:00Z"));

    // A tag stores its resolved window, so `compare` can state what each side
    // covers instead of leaving the reader to assume the two windows matched.
    await run("node", [CLI, "tag", "july", "--from", "2026-07-01", "--to", "2026-08-01", ...shared]);
    await run("node", [CLI, "tag", "august", "--from", "2026-08-01", "--to", "2026-09-01", ...shared]);
    const comparison = (await run("node", [CLI, "compare", "july", "august", "--index", index])).stdout;
    assert.match(comparison, /Windows \(start inclusive, end exclusive\):/);
    assert.match(comparison, /july\s+2026-07-01T00:00:00\.000Z → 2026-08-01T00:00:00\.000Z/);
    assert.match(comparison, /august\s+2026-08-01T00:00:00\.000Z → 2026-09-01T00:00:00\.000Z/);
    assert.ok(!comparison.includes(SECRET));

    const conflict = await runWithStdin(["report", "--since", "7d", "--from", "2026-07-01", ...shared], "");
    assert.equal(conflict.code, 1);
    assert.match(conflict.stderr, /use one or the other/);
    const malformed = await runWithStdin(["report", "--from", "last July", ...shared], "");
    assert.equal(malformed.code, 1);
    assert.match(malformed.stderr, /Invalid --from value/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a deleted log file keeps its spend, and prune-index is the only way to drop it", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-finops-retired-cli-"));
  try {
    mkdirSync(join(root, "project"));
    const index = join(root, "index.json");
    const kept = join(root, "project", "kept.jsonl");
    const deleted = join(root, "project", "deleted.jsonl");
    const line = (id, output, day = "01") => `{"type":"assistant","requestId":"${id}","timestamp":"2026-08-${day}T10:00:00Z","message":{"id":"${id}","model":"claude-sonnet-4-6","content":"${SECRET}","usage":{"input_tokens":10,"output_tokens":${output}}}}`;
    writeFileSync(kept, line("r1", 5));
    writeFileSync(deleted, line("r2", 25));
    const before = JSON.parse((await run("node", [CLI, "report", "--json", "--log-dir", root, "--index", index, "--fresh"])).stdout);
    assert.equal(before.topSessions.length, 2);

    // Claude Code prunes its own transcripts. The index is a durable store, not
    // a cache of what is currently on disk, so the estimate must not move.
    rmSync(deleted);
    const after = JSON.parse((await run("node", [CLI, "report", "--json", "--log-dir", root, "--index", index, "--fresh"])).stdout);
    assert.equal(after.total.usd, before.total.usd);
    assert.equal(after.total.requests, before.total.requests);
    assert.deepEqual(after.topSessions.map((session) => session.id).sort(), before.topSessions.map((session) => session.id).sort());
    assert.ok(!JSON.stringify(after).includes(SECRET));

    // Retired history is bounded only on request. A cutoff that predates the
    // records removes nothing; one that postdates them removes exactly them.
    const untouched = JSON.parse((await run("node", [CLI, "prune-index", "--older-than", "52w", "--json", "--index", index])).stdout);
    assert.equal(untouched.removedRecords, 0);
    assert.equal(untouched.remainingRecords, 1);
    const pruned = JSON.parse((await run("node", [CLI, "prune-index", "--older-than", "24h", "--json", "--index", index])).stdout);
    assert.equal(pruned.removedRecords, 1);
    assert.equal(pruned.removedSources, 1);
    const dropped = JSON.parse((await run("node", [CLI, "report", "--json", "--log-dir", root, "--index", index])).stdout);
    assert.equal(dropped.topSessions.length, 1);
    assert.ok(dropped.total.usd < before.total.usd);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the per-install salt never leaves the index file", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-finops-salt-cli-"));
  const labels = join(root, "labels.json");
  try {
    mkdirSync(join(root, "project"));
    const index = join(root, "index.json");
    const log = join(root, "project", "session.jsonl");
    writeFileSync(log, [
      JSON.stringify({ type: "assistant", requestId: "r1", timestamp: "2026-08-01T10:00:00Z", message: { id: "m1", model: "claude-sonnet-4-6", content: [{ type: "tool_use", id: "call-1", name: "mcp__issues__search", input: { query: SECRET } }], usage: { input_tokens: 2, output_tokens: 3 } } }),
      JSON.stringify({ type: "assistant", requestId: "r2", timestamp: "2026-08-01T10:01:00Z", message: { id: "m2", model: "claude-sonnet-4-6", content: SECRET, usage: { input_tokens: 100, output_tokens: 20 } } }),
    ].join("\n"));
    // `hotspots` now consults the filter ledger, so it is pointed inside the
    // fixture: a test must not read the developer's own local state.
    const env = { AGENT_FINOPS_LABELS: labels, AGENT_FINOPS_FILTER_DIR: join(root, "filter") };
    await run("node", [CLI, "scan", "--log-dir", root, "--index", index], { env: { ...process.env, ...env } });

    // A known salt in place of the generated one, so every command's output can
    // be searched for it directly.
    const stored = JSON.parse(readFileSync(index, "utf8"));
    assert.match(stored.salt, /^[a-f0-9]{64}$/, "a generated salt is 32 random bytes");
    stored.salt = SALT;
    writeFileSync(index, JSON.stringify(stored));

    const sessions = JSON.parse((await run("node", [CLI, "sessions", "--json", "--index", index])).stdout);
    const projectRows = JSON.parse((await run("node", [CLI, "projects", "--json", "--index", index])).stdout);

    // A local label is the newest thing to reach terminal output: `report`,
    // `sessions`, `session`, and `projects` all name an anonymous id with one
    // now. The name is the user's own and holds no path, but the lines that
    // print it are still lines, and they must carry no salt and no prompt
    // content either. Checked before the rescanning commands below, which
    // re-fingerprint every id against the substituted salt.
    await run("node", [CLI, "label", projectRows[0].id, "Payments API"], { env: { ...process.env, ...env } });
    for (const command of [["report"], ["sessions"], ["session", sessions[0].id], ["projects"]]) {
      const { stdout } = await run("node", [CLI, ...command, "--log-dir", root, "--index", index], { env: { ...process.env, ...env } });
      assert.ok(stdout.includes("Payments API"), `${command[0]} should name the labelled project`);
      assert.ok(!stdout.includes(SALT), `${command[0]} leaked the salt beside a label`);
      assert.ok(!stdout.includes(SECRET), `${command[0]} leaked prompt content beside a label`);
    }
    // A label is a local name for an id, not a fact about the workload: it names
    // rows in the terminal and stays out of the JSON people share.
    assert.ok(!(await run("node", [CLI, "report", "--json", "--log-dir", root, "--index", index], { env: { ...process.env, ...env } })).stdout.includes("Payments API"));

    const commands = [
      ["report", "--json"], ["report"],
      ["hotspots", "--json"], ["hotspots"],
      ["tools", "--json"], ["mcp", "--json"],
      ["sessions", "--json"], ["sessions"], ["projects", "--json"], ["projects"],
      ["trend", "--json"], ["trend"],
      ["session", sessions[0].id, "--json"],
      ["project", projectRows[0].id, "--json"], ["project", projectRows[0].id],
      ["scan", "--json"], ["scan"],
      ["tag", "windowed", "--json"], ["compare", "windowed", "windowed"],
      ["doctor"],
    ];
    for (const command of commands) {
      const { stdout, stderr } = await run("node", [CLI, ...command, "--log-dir", root, "--index", index], { env: { ...process.env, ...env } });
      assert.ok(!stdout.includes(SALT), `${command[0]} stdout leaked the salt`);
      assert.ok(!stderr.includes(SALT), `${command[0]} stderr leaked the salt`);
      assert.ok(!stdout.includes(SECRET), `${command[0]} stdout leaked prompt content`);
    }
    // The tag payload is stored in the same file as the salt; it must not copy it.
    assert.ok(!JSON.stringify(JSON.parse(readFileSync(index, "utf8")).tags).includes(SALT));

    // `dashboard` serves rather than prints, so its page is rendered from the
    // same report object the JSON commands emit and checked directly. It is the
    // one view that also carries local project labels, so it renders with them —
    // and, like the real command, the trend its "what changed" section reads.
    const dashboardRecords = indexedRecords(loadIndex(index));
    const page = renderDashboard(
      buildReport(dashboardRecords, { sessionLimit: 12, toolLimit: 12, projectLimit: 12 }),
      { recommendations: [] },
      Object.fromEntries(dashboardRecords.filter((record) => record.project).map((record) => [record.project, "Payments API"])),
      analyzeTrend(dashboardRecords, { days: 7, now: new Date("2026-08-03T00:00:00Z") }),
    );
    assert.ok(!page.includes(SALT), "the dashboard page leaked the salt");
    assert.ok(!page.includes(SECRET), "the dashboard page leaked prompt content");
    assert.ok(page.includes("Payments API"), "a labelled project should reach the page");
    // The driver rows are the newest thing to reach the page, and they are built
    // from project ids: a label or a six-character prefix, never the salted id
    // itself and never the two nested reports the trend carries.
    const changed = JSON.parse(/const DATA = (.*);\n/.exec(page)[1]).changed;
    assert.ok(changed, "the section receives the trend the command built");
    assert.ok(!JSON.stringify(changed).includes(SALT));
    assert.ok(!JSON.stringify(changed).includes(SECRET));
    for (const row of changed.byProject) assert.ok(!dashboardRecords.some((record) => record.project === row.name), "a full project fingerprint reached the page");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the CLI still runs when it is invoked through an installed symlink", async () => {
  // `scripts/install-local.sh` puts a symlink on PATH. The entry-point guard
  // that keeps the helpers importable must not turn that into a silent no-op.
  const root = mkdtempSync(join(tmpdir(), "agent-finops-link-"));
  try {
    const link = join(root, "agent-finops");
    symlinkSync(CLI, link);
    const { stdout } = await run("node", [link, "--help"]);
    assert.match(stdout, /^Usage:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
