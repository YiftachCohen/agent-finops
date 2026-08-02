import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.mjs");
const SECRET = "TOP-SECRET-EXAMPLE";

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
    // This JSON is the artifact people share; an absolute path would carry the
    // local username. `doctor` is where paths are printed.
    assert.ok(!stdout.includes(root), "no log-dir path");
    assert.ok(!stdout.includes(index), "no index path");
    assert.ok(!/\/(Users|home)\//.test(stdout), "no home-directory path");
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
