import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readClaudeRecords } from "../src/logs.mjs";
import { buildReport, humanTools } from "../src/report.mjs";

const SECRET = "MCP-ARGUMENT-AND-RESULT-MUST-NOT-PERSIST";

test("attributes a following billed turn to prior MCP calls without retaining arguments or results", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-finops-tools-"));
  const path = join(root, "session.jsonl");
  try {
    const lines = [
      JSON.stringify({ type: "assistant", requestId: "call-request", timestamp: "2026-08-01T10:00:00Z", message: { id: "call-message", model: "claude-sonnet-4-6", content: [{ type: "tool_use", id: "call-1", name: "mcp__issues__search", input: { query: SECRET } }, { type: "tool_use", id: "call-2", name: "mcp__docs__lookup", input: { query: SECRET } }], usage: { input_tokens: 2, output_tokens: 3 } } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call-1", content: SECRET }] } }),
      JSON.stringify({ type: "assistant", requestId: "follow-request", timestamp: "2026-08-01T10:01:00Z", message: { id: "follow-message", model: "claude-sonnet-4-6", content: SECRET, usage: { input_tokens: 100, output_tokens: 20 } } }),
    ];
    writeFileSync(path, lines.join("\n"));
    const read = await readClaudeRecords({ path, source: "session-hash", project: "project-hash" });
    assert.equal(read.records.length, 2);
    assert.deepEqual(read.records[0].tools, ["mcp__issues__search", "mcp__docs__lookup"]);
    assert.deepEqual(read.records[1].priorTools, ["mcp__issues__search", "mcp__docs__lookup"]);
    assert.ok(!JSON.stringify(read.records).includes(SECRET));

    const report = buildReport(read.records, { toolLimit: 10 });
    assert.equal(report.topTools.length, 2);
    assert.equal(report.topTools[0].calls, 1);
    assert.equal(report.topTools[0].followOnRequests, 1);
    assert.equal(report.topTools[0].usage.total, 60);
    const followOnOnly = buildReport([read.records[1]]);
    assert.ok(Math.abs((report.topTools[0].usd + report.topTools[1].usd) - followOnOnly.total.usd) < 1e-12);
    assert.match(humanTools(report.topTools, { onlyMcp: true }), /correlation for prioritization/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
