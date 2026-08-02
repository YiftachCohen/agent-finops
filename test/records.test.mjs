import test from "node:test";
import assert from "node:assert/strict";
import { recordFromClaudeRawLine, redactSensitiveProperties, toolNamesFromClaudeRawLine } from "../src/records.mjs";

const SECRET = "PRIVATE-PROMPT-MUST-NOT-BE-PARSED";

test("redacts nested content before JSON decoding while preserving valid JSON", () => {
  const raw = JSON.stringify({ type: "assistant", message: { content: SECRET, nested: { text: SECRET }, usage: { input_tokens: 3 } } });
  const redacted = redactSensitiveProperties(raw);
  assert.ok(!redacted.includes(SECRET));
  const parsed = JSON.parse(redacted);
  assert.equal(parsed.message.content, null);
  assert.equal(parsed.message.nested.text, null);
  assert.equal(parsed.message.usage.input_tokens, 3);
});

test("user content rows are rejected without JSON parsing", () => {
  const raw = `{"type":"user","message":{"content":"${SECRET}"}}`;
  assert.equal(recordFromClaudeRawLine(raw, "/tmp/a.jsonl"), null);
});

test("assistant record exports whitelisted accounting metadata only", () => {
  const raw = JSON.stringify({
    type: "assistant",
    requestId: "request-1",
    timestamp: "2026-08-01T10:00:00Z",
    message: {
      id: "message-1",
      model: "us.anthropic.claude-sonnet-4-6-20260101-v1:0",
      content: SECRET,
      usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 40 },
    },
  });
  const record = recordFromClaudeRawLine(raw, "/private/local/session.jsonl");
  assert.deepEqual(record.usage, { input: 10, cacheCreate: 20, cacheRead: 30, output: 40 });
  assert.equal(record.model, "us.anthropic.claude-sonnet-4-6-20260101-v1:0");
  assert.equal(record.content, undefined);
  assert.equal(record.source.length, 12);
});

test("supports Claude Code's message envelope without reading its content", () => {
  const raw = JSON.stringify({
    type: "message",
    requestId: "request-2",
    timestamp: "2026-08-01T10:00:00Z",
    message: { id: "message-2", role: "assistant", model: "claude-sonnet-4-6", content: SECRET, usage: { input_tokens: 2, output_tokens: 3 } },
  });
  const record = recordFromClaudeRawLine(raw, "/tmp/wrapped.jsonl");
  assert.deepEqual(record.usage, { input: 2, cacheCreate: 0, cacheRead: 0, output: 3 });
});

test("extracts only a safe tool name and never tool input", () => {
  const raw = JSON.stringify({
    type: "assistant",
    requestId: "request-3",
    timestamp: "2026-08-01T10:00:00Z",
    message: {
      id: "message-3",
      model: "claude-sonnet-4-6",
      content: [{ type: "tool_use", id: "call-1", name: "mcp__issues__search", input: { query: SECRET, nested: { name: SECRET } } }],
      usage: { input_tokens: 2, output_tokens: 3 },
    },
  });
  assert.deepEqual(toolNamesFromClaudeRawLine(raw), ["mcp__issues__search"]);
  const record = recordFromClaudeRawLine(raw, "/tmp/wrapped.jsonl");
  assert.deepEqual(record.tools, ["mcp__issues__search"]);
  assert.ok(!JSON.stringify(record).includes(SECRET));
});

test("never extracts tool-like user content", () => {
  const raw = JSON.stringify({ type: "user", message: { content: [{ type: "tool_use", name: "mcp__secret__leak", input: SECRET }] } });
  assert.deepEqual(toolNamesFromClaudeRawLine(raw), []);
});

test("malformed assistant record is reported without exposing its contents", () => {
  assert.deepEqual(recordFromClaudeRawLine('{"type":"assistant","message":{"content":"x"', "/tmp/a"), { parseError: true });
});
