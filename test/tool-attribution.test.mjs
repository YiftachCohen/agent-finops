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
    // The fixture's last line carries no newline, as an open session's does, so
    // the freshest turn arrives as an uncommitted tail record. Reports read both.
    const records = [...read.records, ...read.tailRecords];
    assert.equal(records.length, 2);
    assert.deepEqual(records[0].tools, ["mcp__issues__search", "mcp__docs__lookup"]);
    assert.deepEqual(records[1].priorTools, ["mcp__issues__search", "mcp__docs__lookup"]);
    assert.ok(!JSON.stringify(records).includes(SECRET));

    const report = buildReport(records, { toolLimit: 10 });
    assert.equal(report.topTools.length, 2);
    assert.equal(report.topTools[0].calls, 1);
    assert.equal(report.topTools[0].followOnRequests, 1);
    assert.equal(report.topTools[0].usage.total, 60);
    const followOnOnly = buildReport([records[1]]);
    assert.ok(Math.abs((report.topTools[0].usd + report.topTools[1].usd) - followOnOnly.total.usd) < 1e-12);
    assert.match(humanTools(report.topTools, { onlyMcp: true }), /correlation for prioritization/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a solo cohort keeps the tool's full share while a shared cohort still splits, and rows sum to the unsplit total", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-finops-solo-"));
  const path = join(root, "session.jsonl");
  try {
    const lines = [
      // A single-tool cohort: Bash is the only tool called, so the following
      // billed turn is the strongest correlation the model can produce.
      JSON.stringify({ type: "assistant", requestId: "call1-request", timestamp: "2026-08-01T10:00:00Z", message: { id: "call1-message", model: "claude-sonnet-4-6", content: [{ type: "tool_use", id: "call-1", name: "Bash", input: { command: SECRET } }], usage: { input_tokens: 1, output_tokens: 1 } } }),
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: SECRET }] } }),
      JSON.stringify({ type: "assistant", requestId: "solo-follow-request", timestamp: "2026-08-01T10:01:00Z", message: { id: "solo-follow-message", model: "claude-sonnet-4-6", content: SECRET, usage: { input_tokens: 100, output_tokens: 20 } } }),
      // A fresh human prompt ends that cohort.
      JSON.stringify({ type: "user", message: { role: "user", content: SECRET } }),
      // A two-tool cohort: Bash and Read are both called, so the following
      // billed turn is an equal split between them.
      JSON.stringify({ type: "assistant", requestId: "call2-request", timestamp: "2026-08-01T10:02:00Z", message: { id: "call2-message", model: "claude-sonnet-4-6", content: [{ type: "tool_use", id: "call-2", name: "Bash", input: { command: SECRET } }, { type: "tool_use", id: "call-3", name: "Read", input: { file_path: SECRET } }], usage: { input_tokens: 1, output_tokens: 1 } } }),
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call-2", content: SECRET }] } }),
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call-3", content: SECRET }] } }),
      JSON.stringify({ type: "assistant", requestId: "shared-follow-request", timestamp: "2026-08-01T10:03:00Z", message: { id: "shared-follow-message", model: "claude-sonnet-4-6", content: SECRET, usage: { input_tokens: 1000, output_tokens: 200 } } }),
    ];
    writeFileSync(path, lines.join("\n"));
    const read = await readClaudeRecords({ path, source: "session-hash", project: "project-hash" });
    const records = [...read.records, ...read.tailRecords];
    assert.equal(records.length, 4);
    assert.ok(!JSON.stringify(records).includes(SECRET));

    const report = buildReport(records, { toolLimit: 10 });
    const bash = report.topTools.find((tool) => tool.name === "Bash");
    const read2 = report.topTools.find((tool) => tool.name === "Read");
    assert.ok(bash && read2);

    // Bash was called in both cohorts (calls=2), Read only in the second (calls=1).
    assert.equal(bash.calls, 2);
    assert.equal(read2.calls, 1);
    // Bash's cohort closed twice; only the first was solo.
    assert.equal(bash.followOnRequests, 2);
    assert.equal(bash.soloFollowOnRequests, 1);
    assert.equal(read2.followOnRequests, 1);
    assert.equal(read2.soloFollowOnRequests, 0);

    const soloFollowOnCost = buildReport([records[1]]).total.usd;
    const sharedFollowOnCost = buildReport([records[3]]).total.usd;
    // Bash keeps the whole solo turn's cost plus half the shared turn's; Read
    // only ever sees the shared half.
    assert.ok(Math.abs(bash.soloUsd - soloFollowOnCost) < 1e-12);
    assert.ok(Math.abs(bash.usd - (soloFollowOnCost + sharedFollowOnCost / 2)) < 1e-12);
    assert.ok(Math.abs(read2.usd - sharedFollowOnCost / 2) < 1e-12);
    assert.equal(read2.soloUsd, 0);

    // Rows still sum to the unsplit total across both follow-on turns.
    assert.ok(Math.abs((bash.usd + read2.usd) - (soloFollowOnCost + sharedFollowOnCost)) < 1e-12);

    // Solo share: all of Bash's own solo turn out of its total attributed cost;
    // none of Read's, since it never had a solo cohort.
    assert.ok(Math.abs(bash.soloShare - soloFollowOnCost / bash.usd) < 1e-12);
    assert.equal(read2.soloShare, 0);

    const rendered = humanTools(report.topTools);
    assert.match(rendered, /Bash.*\$\d+\.\d{3}\/call.*solo \d+%/);
    assert.match(rendered, /Read.*\$\d+\.\d{3}\/call.*solo 0%/);
    assert.match(rendered, /the correlation is less diluted/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Claude Code streams each `tool_use` content block of one assistant message as
 * its own JSONL line, so a parallel call arrives as several lines sharing a
 * `message.id`. The cohort is the whole message, not the last line of it.
 */
test("tools called in parallel share one cohort instead of the last line taking the turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-finops-parallel-"));
  const path = join(root, "session.jsonl");
  const call = (mid, rid, id, name) =>
    JSON.stringify({ type: "assistant", requestId: rid, timestamp: "2026-08-01T10:00:00Z", message: { id: mid, model: "claude-sonnet-4-6", content: [{ type: "tool_use", id, name, input: { command: SECRET } }], usage: { input_tokens: 1, output_tokens: 1 } } });
  const result = (id) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: SECRET }] } });
  try {
    writeFileSync(path, [
      // One message, two tool_use blocks, two lines: the same id and the same
      // request, exactly as streaming writes them.
      call("m-parallel", "r-parallel", "call-1", "Bash"),
      call("m-parallel", "r-parallel", "call-2", "Read"),
      result("call-1"),
      result("call-2"),
      JSON.stringify({ type: "assistant", requestId: "r-shared", timestamp: "2026-08-01T10:01:00Z", message: { id: "m-shared", model: "claude-sonnet-4-6", content: SECRET, usage: { input_tokens: 1000, output_tokens: 200 } } }),
      // A fresh prompt, then a cohort where Bash really is on its own.
      JSON.stringify({ type: "user", message: { role: "user", content: SECRET } }),
      call("m-solo-call", "r-solo-call", "call-3", "Bash"),
      result("call-3"),
      JSON.stringify({ type: "assistant", requestId: "r-solo", timestamp: "2026-08-01T10:02:00Z", message: { id: "m-solo", model: "claude-sonnet-4-6", content: SECRET, usage: { input_tokens: 100, output_tokens: 20 } } }),
      "",
    ].join("\n"));
    const read = await readClaudeRecords({ path, source: "session-hash", project: "project-hash" });
    const records = [...read.records, ...read.tailRecords];
    assert.equal(records.length, 5);
    assert.ok(!JSON.stringify(records).includes(SECRET));

    // The second line of the parallel message must not inherit its own sibling's
    // tool: its cohort is whatever closed before the message opened.
    assert.equal(records[0].priorTools, undefined);
    assert.equal(records[1].priorTools, undefined);
    // The billed turn that answers both tool results is attributed to both.
    assert.deepEqual(records[2].priorTools, ["Bash", "Read"]);
    assert.equal(records[3].priorTools, undefined, "a fresh prompt closed the parallel cohort");
    assert.deepEqual(records[4].priorTools, ["Bash"]);

    const report = buildReport(records, { toolLimit: 10 });
    const bash = report.topTools.find((tool) => tool.name === "Bash");
    const readTool = report.topTools.find((tool) => tool.name === "Read");
    const sharedCost = buildReport([records[2]]).total.usd;
    const soloCost = buildReport([records[4]]).total.usd;

    // An equal split, which the winner-takes-all accumulator never produced.
    assert.ok(Math.abs(readTool.usd - sharedCost / 2) < 1e-12);
    assert.ok(Math.abs(bash.usd - (sharedCost / 2 + soloCost)) < 1e-12);
    // Rows still sum to the unsplit total of both follow-on turns.
    assert.ok(Math.abs((bash.usd + readTool.usd) - (sharedCost + soloCost)) < 1e-12);
    assert.equal(bash.followOnRequests, 2);
    assert.equal(readTool.followOnRequests, 1);
    // Every cohort used to be a cohort of one, so every solo share was 100%.
    assert.ok(bash.soloShare > 0 && bash.soloShare < 1);
    assert.ok(Math.abs(bash.soloShare - soloCost / bash.usd) < 1e-12);
    assert.equal(readTool.soloShare, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("every tool_use block of a message is counted once, whichever streamed row survives dedup", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-finops-calls-"));
  const path = join(root, "session.jsonl");
  // The same message and the same request, as streaming writes them: keep-last
  // deduplication collapses these three rows into the final one.
  const line = (body) => JSON.stringify({ type: "assistant", requestId: "r-parallel", timestamp: "2026-08-01T10:00:00Z", message: { id: "m-parallel", model: "claude-sonnet-4-6", content: body, usage: { input_tokens: 1, output_tokens: 1 } } });
  try {
    writeFileSync(path, [
      line([{ type: "tool_use", id: "call-1", name: "Bash", input: { command: SECRET } }]),
      line([{ type: "tool_use", id: "call-2", name: "Read", input: { file_path: SECRET } }]),
      // The row that actually survives carries no tool_use block of its own.
      line(SECRET),
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: SECRET }] } }),
      JSON.stringify({ type: "assistant", requestId: "r-follow", timestamp: "2026-08-01T10:01:00Z", message: { id: "m-follow", model: "claude-sonnet-4-6", content: SECRET, usage: { input_tokens: 1000, output_tokens: 200 } } }),
      "",
    ].join("\n"));
    const read = await readClaudeRecords({ path, source: "session-hash", project: "project-hash" });
    const records = [...read.records, ...read.tailRecords];
    assert.ok(!JSON.stringify(records).includes(SECRET));
    // Each row carries the message's blocks up to it, so the surviving row holds
    // both — a per-line list would have left it empty.
    assert.deepEqual(records.map((record) => record.tools), [["Bash"], ["Bash", "Read"], ["Bash", "Read"], []]);

    const report = buildReport(records, { toolLimit: 10 });
    const bash = report.topTools.find((tool) => tool.name === "Bash");
    const readTool = report.topTools.find((tool) => tool.name === "Read");
    assert.ok(bash && readTool, "a tool called only on a dropped sibling line still gets a row");
    assert.equal(bash.calls, 1);
    assert.equal(readTool.calls, 1);
    // With no call counted, per-use economics were null despite real cost.
    assert.ok(Math.abs(bash.usdPerCall - bash.usd) < 1e-12);
    assert.ok(Math.abs(readTool.usdPerCall - readTool.usd) < 1e-12);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("two messages calling the same tool count two calls", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-finops-calls-repeat-"));
  const path = join(root, "session.jsonl");
  const call = (mid, id) => JSON.stringify({ type: "assistant", requestId: `r-${mid}`, timestamp: "2026-08-01T10:00:00Z", message: { id: mid, model: "claude-sonnet-4-6", content: [{ type: "tool_use", id, name: "Bash", input: { command: SECRET } }], usage: { input_tokens: 1, output_tokens: 1 } } });
  const result = (id) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: SECRET }] } });
  try {
    writeFileSync(path, [
      call("m1", "call-1"),
      result("call-1"),
      call("m2", "call-2"),
      result("call-2"),
      JSON.stringify({ type: "assistant", requestId: "r-follow", timestamp: "2026-08-01T10:02:00Z", message: { id: "m-follow", model: "claude-sonnet-4-6", content: SECRET, usage: { input_tokens: 100, output_tokens: 20 } } }),
      "",
    ].join("\n"));
    const read = await readClaudeRecords({ path, source: "session-hash", project: "project-hash" });
    const records = [...read.records, ...read.tailRecords];
    // Accumulation is per message, so it must not run on into the next one.
    assert.deepEqual(records.map((record) => record.tools), [["Bash"], ["Bash"], []]);
    const report = buildReport(records, { toolLimit: 10 });
    assert.equal(report.topTools.find((tool) => tool.name === "Bash").calls, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a cohort does not accumulate across the message that closed it", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-finops-sequential-"));
  const path = join(root, "session.jsonl");
  const call = (mid, rid, id, name) =>
    JSON.stringify({ type: "assistant", requestId: rid, timestamp: "2026-08-01T10:00:00Z", message: { id: mid, model: "claude-sonnet-4-6", content: [{ type: "tool_use", id, name, input: { command: SECRET } }], usage: { input_tokens: 1, output_tokens: 1 } } });
  const result = (id) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: SECRET }] } });
  try {
    writeFileSync(path, [
      call("m1", "r1", "call-1", "Bash"),
      result("call-1"),
      // This turn is Bash's follow-on, and it opens a cohort of its own.
      call("m2", "r2", "call-2", "Edit"),
      result("call-2"),
      JSON.stringify({ type: "assistant", requestId: "r3", timestamp: "2026-08-01T10:03:00Z", message: { id: "m3", model: "claude-sonnet-4-6", content: SECRET, usage: { input_tokens: 100, output_tokens: 20 } } }),
      "",
    ].join("\n"));
    const read = await readClaudeRecords({ path, source: "session-hash", project: "project-hash" });
    const records = [...read.records, ...read.tailRecords];
    assert.deepEqual(records[1].priorTools, ["Bash"]);
    // Grouping by message must not turn into grouping by session: Bash's cohort
    // closed when `m2` opened, so it cannot ride along into `m3`'s.
    assert.deepEqual(records[2].priorTools, ["Edit"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a tool-use line with no billing payload joins its own message's cohort", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-finops-unbilled-"));
  const path = join(root, "session.jsonl");
  const unbilled = (mid, id, name) =>
    JSON.stringify({ type: "assistant", requestId: "r-unbilled", timestamp: "2026-08-01T10:00:00Z", message: { id: mid, model: "claude-sonnet-4-6", content: [{ type: "tool_use", id, name, input: { command: SECRET } }] } });
  const result = (id) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: SECRET }] } });
  try {
    writeFileSync(path, [
      JSON.stringify({ type: "assistant", requestId: "r-a", timestamp: "2026-08-01T10:00:00Z", message: { id: "m-a", model: "claude-sonnet-4-6", content: [{ type: "tool_use", id: "call-1", name: "Bash", input: { command: SECRET } }], usage: { input_tokens: 1, output_tokens: 1 } } }),
      // Same message, no usage of its own: it is a sibling block, not a cohort.
      unbilled("m-a", "call-2", "Grep"),
      result("call-1"),
      JSON.stringify({ type: "assistant", requestId: "r-b", timestamp: "2026-08-01T10:01:00Z", message: { id: "m-b", model: "claude-sonnet-4-6", content: SECRET, usage: { input_tokens: 100, output_tokens: 20 } } }),
      // A new message id, still with no billing payload: it closes the previous
      // cohort and opens its own.
      unbilled("m-c", "call-3", "Write"),
      result("call-3"),
      JSON.stringify({ type: "assistant", requestId: "r-d", timestamp: "2026-08-01T10:02:00Z", message: { id: "m-d", model: "claude-sonnet-4-6", content: SECRET, usage: { input_tokens: 50, output_tokens: 10 } } }),
      "",
    ].join("\n"));
    const read = await readClaudeRecords({ path, source: "session-hash", project: "project-hash" });
    const records = [...read.records, ...read.tailRecords];
    assert.equal(records.length, 3);
    assert.deepEqual(records[1].priorTools, ["Bash", "Grep"]);
    assert.deepEqual(records[2].priorTools, ["Write"]);
    assert.ok(!JSON.stringify(records).includes(SECRET));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a fresh human turn resets the open message, not only the closed cohort", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-finops-reset-"));
  const path = join(root, "session.jsonl");
  const call = (mid, id, name) =>
    JSON.stringify({ type: "assistant", requestId: `r-${id}`, timestamp: "2026-08-01T10:00:00Z", message: { id: mid, model: "claude-sonnet-4-6", content: [{ type: "tool_use", id, name, input: { command: SECRET } }], usage: { input_tokens: 1, output_tokens: 1 } } });
  try {
    writeFileSync(path, [
      call("m-a", "call-1", "Bash"),
      JSON.stringify({ type: "user", message: { role: "user", content: SECRET } }),
      // Same message id as before the prompt. The reset cleared the in-progress
      // group too, so this cannot rejoin a cohort the user already ended.
      call("m-a", "call-2", "Read"),
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call-2", content: SECRET }] } }),
      JSON.stringify({ type: "assistant", requestId: "r-follow", timestamp: "2026-08-01T10:02:00Z", message: { id: "m-follow", model: "claude-sonnet-4-6", content: SECRET, usage: { input_tokens: 100, output_tokens: 20 } } }),
      "",
    ].join("\n"));
    const read = await readClaudeRecords({ path, source: "session-hash", project: "project-hash" });
    const records = [...read.records, ...read.tailRecords];
    assert.equal(records[0].priorTools, undefined);
    assert.equal(records[1].priorTools, undefined);
    assert.deepEqual(records[2].priorTools, ["Read"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a fresh human turn ends the cohort instead of charging the last tool forever", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-finops-cohort-"));
  const path = join(root, "session.jsonl");
  try {
    writeFileSync(path, [
      JSON.stringify({ type: "assistant", requestId: "r1", timestamp: "2026-08-01T10:00:00Z", message: { id: "m1", model: "claude-sonnet-4-6", content: [{ type: "tool_use", id: "call-1", name: "Bash", input: { command: SECRET } }], usage: { input_tokens: 1, output_tokens: 1 } } }),
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: SECRET }] } }),
      // The billed turn that directly answers the tool result is attributable.
      JSON.stringify({ type: "assistant", requestId: "r2", timestamp: "2026-08-01T10:01:00Z", message: { id: "m2", model: "claude-sonnet-4-6", content: SECRET, usage: { input_tokens: 100, output_tokens: 20 } } }),
      // This is a new human prompt, so everything after it is not Bash's cost.
      JSON.stringify({ type: "user", message: { role: "user", content: SECRET } }),
      JSON.stringify({ type: "assistant", requestId: "r3", timestamp: "2026-08-01T10:05:00Z", message: { id: "m3", model: "claude-sonnet-4-6", content: SECRET, usage: { input_tokens: 9999, output_tokens: 500 } } }),
    ].join("\n"));
    const read = await readClaudeRecords({ path, source: "session-hash", project: "project-hash" });
    const records = [...read.records, ...read.tailRecords];
    assert.equal(records.length, 3);
    assert.deepEqual(records[1].priorTools, ["Bash"]);
    assert.equal(records[2].priorTools, undefined);

    const report = buildReport(records, { toolLimit: 10 });
    const bash = report.topTools.find((tool) => tool.name === "Bash");
    assert.equal(bash.followOnRequests, 1);
    assert.equal(bash.usage.total, 120);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
