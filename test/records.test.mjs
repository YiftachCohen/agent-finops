import test from "node:test";
import assert from "node:assert/strict";
import { fingerprint, messageIdFromClaudeRawLine, recordFromClaudeRawLine, redactSensitiveProperties, toolNamesFromClaudeRawLine } from "../src/records.mjs";

const SECRET = "PRIVATE-PROMPT-MUST-NOT-BE-PARSED";

test("a fingerprint is salted, so the same pre-image gives a different id per install", () => {
  const path = "/synthetic/example/.claude/projects/-synthetic-example-acme-billing/session.jsonl";
  const left = "fixture-salt-left-0123456789";
  const right = "fixture-salt-right-0123456789";

  // The pre-image is a home path or a repository name: low entropy, highly
  // structured, and therefore cheap to confirm-or-deny against a bare hash.
  assert.notEqual(fingerprint(path, left), fingerprint(path, right));
  assert.notEqual(fingerprint(path, left), fingerprint(path));
  assert.equal(fingerprint(path, left), fingerprint(path, left));
  assert.match(fingerprint(path, left), /^[a-f0-9]{12}$/);

  // The salt is not recoverable from, and does not appear in, the id it makes.
  assert.ok(!fingerprint(path, left).includes(left));
});

test("redacts nested content before JSON decoding while preserving valid JSON", () => {
  const raw = JSON.stringify({ type: "assistant", message: { content: SECRET, nested: { text: SECRET }, usage: { input_tokens: 3 } } });
  const redacted = redactSensitiveProperties(raw);
  assert.ok(!redacted.includes(SECRET));
  const parsed = JSON.parse(redacted);
  assert.equal(parsed.message.content, null);
  assert.equal(parsed.message.nested.text, null);
  assert.equal(parsed.message.usage.input_tokens, 3);
});

test("an escaped key cannot smuggle content past the redaction denylist", () => {
  // The decoder resolves `content` to `content`, so comparing the key's
  // source text against the denylist missed it while JSON.parse still decoded
  // the value. Each of these keys must be treated as the name it decodes to.
  const escaped = [
    `{"message":{"\\u0063ontent":"${SECRET}"}}`,
    `{"message":{"too\\u006cUse\\u0052esult":{"stdout":"${SECRET}"}}}`,
    `{"message":{"\\u0074e\\u0078t":"${SECRET}"}}`,
  ];
  for (const raw of escaped) {
    const redacted = redactSensitiveProperties(raw);
    assert.ok(!redacted.includes(SECRET), raw);
    assert.equal(Object.values(JSON.parse(redacted).message)[0], null, raw);
  }
});

test("a key with an escaped quote keeps the redaction lexer aligned", () => {
  const raw = `{"type":"assistant","message":{"we\\"ird":"harmless","content":"${SECRET}"}}`;
  const parsed = JSON.parse(redactSensitiveProperties(raw));
  assert.equal(parsed.message['we"ird'], "harmless");
  assert.equal(parsed.message.content, null);
});

test("a key whose escapes are malformed is redacted rather than guessed", () => {
  // Over-redaction is the safe direction: an undecodable key name says nothing
  // about whether its value carries transcript content.
  const raw = `{"message":{"conte\\qnt":"${SECRET}","\\uZZZZ":"${SECRET}"}}`;
  const redacted = redactSensitiveProperties(raw);
  assert.ok(!redacted.includes(SECRET));
});

test("an escaped content key never reaches an indexed record", () => {
  const raw = `{"type":"assistant","requestId":"r-esc","timestamp":"2026-08-01T10:00:00Z","message":{"id":"m-esc","model":"claude-sonnet-4-6","\\u0063ontent":"${SECRET}","usage":{"input_tokens":1,"output_tokens":1}}}`;
  const record = recordFromClaudeRawLine(raw, "/tmp/escaped.jsonl");
  assert.equal(record.usage.input, 1);
  assert.ok(!JSON.stringify(record).includes(SECRET));
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
  assert.deepEqual(record.usage, { input: 10, cacheCreate: 20, cacheCreate1h: 0, cacheCreate5m: 0, cacheRead: 30, output: 40 });
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
  assert.deepEqual(record.usage, { input: 2, cacheCreate: 0, cacheCreate1h: 0, cacheCreate5m: 0, cacheRead: 0, output: 3 });
});

test("the envelope type is read at the top level, not from the first nested type", () => {
  // Claude Code writes `message` before the envelope's own `type`, so the first
  // `"type"` in the line belongs to a content block. Both envelope shapes must
  // still be recognised in that order, including when `message` carries no role.
  const assistantFirst = JSON.stringify({
    message: { id: "m-order", model: "claude-opus-5", content: [{ type: "text", text: SECRET }], usage: { input_tokens: 4, output_tokens: 6 } },
    type: "assistant",
    requestId: "r-order",
    timestamp: "2026-08-01T10:00:00Z",
  });
  const assistant = recordFromClaudeRawLine(assistantFirst, "/tmp/order.jsonl");
  assert.equal(assistant.usage.output, 6);
  assert.ok(!JSON.stringify(assistant).includes(SECRET));

  const messageFirst = JSON.stringify({
    message: { id: "m-order-2", role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: SECRET }], usage: { input_tokens: 2, output_tokens: 3 } },
    type: "message",
    requestId: "r-order-2",
    timestamp: "2026-08-01T10:00:00Z",
  });
  assert.equal(recordFromClaudeRawLine(messageFirst, "/tmp/order.jsonl").usage.output, 3);

  const toolFirst = JSON.stringify({
    message: { id: "m-order-3", model: "claude-opus-5", content: [{ type: "tool_use", id: "call-1", name: "Read", input: { file_path: SECRET } }], usage: { input_tokens: 2, output_tokens: 3 } },
    type: "assistant",
    requestId: "r-order-3",
    timestamp: "2026-08-01T10:00:00Z",
  });
  assert.deepEqual(toolNamesFromClaudeRawLine(toolFirst), ["Read"]);
});

test("captured tool output cannot claim to be an assistant envelope", () => {
  // A tool result that captured an assistant record puts `"type":"assistant"`
  // and a tool_use block ahead of the line's own `"type":"user"`. Neither the
  // usage nor the tool name inside that capture belongs to this turn.
  const raw = JSON.stringify({
    toolUseResult: {
      type: "assistant",
      message: { role: "assistant", model: "claude-opus-5", content: [{ type: "tool_use", id: "call-x", name: "Bash", input: { command: SECRET } }], usage: { input_tokens: 999_999, output_tokens: 999_999 } },
    },
    type: "user",
    timestamp: "2026-08-01T10:00:00Z",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call-x", content: SECRET }] },
  });
  assert.equal(recordFromClaudeRawLine(raw, "/tmp/captured.jsonl"), null);
  assert.deepEqual(toolNamesFromClaudeRawLine(raw), []);
});

test("captures the cache-write TTL split that prices a 1-hour write correctly", () => {
  const raw = JSON.stringify({
    type: "assistant",
    requestId: "request-ttl",
    timestamp: "2026-08-01T10:00:00Z",
    message: {
      id: "message-ttl",
      model: "claude-opus-5",
      content: SECRET,
      usage: {
        input_tokens: 1,
        cache_creation_input_tokens: 1000,
        cache_creation: { ephemeral_1h_input_tokens: 900, ephemeral_5m_input_tokens: 100 },
        cache_read_input_tokens: 0,
        output_tokens: 1,
      },
    },
  });
  const record = recordFromClaudeRawLine(raw, "/tmp/ttl.jsonl");
  assert.equal(record.usage.cacheCreate, 1000);
  assert.equal(record.usage.cacheCreate1h, 900);
  assert.equal(record.usage.cacheCreate5m, 100);
});

test("an unsafe model id or timestamp is normalized instead of persisted", () => {
  const line = (model, timestamp = "2026-08-01T10:00:00Z") =>
    `{"type":"assistant","requestId":"r-model","timestamp":${JSON.stringify(timestamp)},"message":{"id":"m-model","model":${JSON.stringify(model)},"usage":{"input_tokens":1,"output_tokens":1}}}`;
  const read = (model, timestamp) => recordFromClaudeRawLine(line(model, timestamp), "/tmp/model.jsonl");

  // The model id is printed to a terminal and shared in JSON, so an escape
  // sequence or an unbounded string must never survive ingestion.
  assert.equal(read("claude-opus-5\u001b[31mALERT\u001b[0m").model, "<unknown>");
  assert.equal(read("x".repeat(500)).model, "<unknown>");
  assert.equal(read("__proto__").model, "<unknown>");
  assert.equal(read("us.anthropic.claude-opus-5[1m]:0").model, "us.anthropic.claude-opus-5[1m]:0");

  // A timestamp that cannot be placed in time is stored as null rather than as
  // free-form text that every reader would have to re-validate.
  assert.equal(read("claude-opus-5", "yesterday afternoon").timestamp, null);
  assert.equal(read("claude-opus-5").timestamp, "2026-08-01T10:00:00Z");
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

test("a message id is lexed off an assistant line, and refused when it is not one", () => {
  // A tool_use line often carries no billing payload, so it never reaches the
  // decoder. Its message id is what says whether it is a sibling block of the
  // message already open or the start of a new cohort.
  const line = (id) => JSON.stringify({
    message: { id, model: "claude-sonnet-4-6", content: [{ type: "tool_use", id: "call-1", name: "Bash", input: { command: SECRET } }] },
    type: "assistant",
    requestId: "r-mid",
    timestamp: "2026-08-01T10:00:00Z",
  });
  assert.equal(messageIdFromClaudeRawLine(line("msg_01AbCdEf-2.0:x")), "msg_01AbCdEf-2.0:x");

  // Anything outside the shape a real id has is reported as absent, which the
  // reader treats as a new message rather than as a match. Over-splitting a
  // cohort is the safe direction; merging two messages is not.
  for (const bad of ["", " ", "has space", 'quote"and{brace', "back\\slash", "-leading-dash", "x".repeat(500), `${SECRET} spilled`]) {
    assert.equal(messageIdFromClaudeRawLine(line(bad)), null, JSON.stringify(bad));
  }
  assert.equal(messageIdFromClaudeRawLine(`{"type":"assistant","message":{"id":123}}`), null, "a non-string id");
  assert.equal(messageIdFromClaudeRawLine(`{"type":"assistant","requestId":"r-mid"}`), null, "no message object at all");
  assert.equal(messageIdFromClaudeRawLine("not json"), null);

  // Non-assistant lines have no cohort identity to contribute, including a tool
  // result that captured an assistant record inside its own envelope.
  assert.equal(messageIdFromClaudeRawLine(`{"type":"user","message":{"id":"msg_user","content":"${SECRET}"}}`), null);
  const captured = JSON.stringify({
    toolUseResult: { type: "assistant", message: { id: "msg_captured", role: "assistant", content: SECRET } },
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call-x", content: SECRET }] },
  });
  assert.equal(messageIdFromClaudeRawLine(captured), null);
});

test("never extracts tool-like user content", () => {
  const raw = JSON.stringify({ type: "user", message: { content: [{ type: "tool_use", name: "mcp__secret__leak", input: SECRET }] } });
  assert.deepEqual(toolNamesFromClaudeRawLine(raw), []);
});

test("malformed assistant record is reported without exposing its contents", () => {
  assert.deepEqual(recordFromClaudeRawLine('{"type":"assistant","message":{"content":"x"', "/tmp/a"), { parseError: true });
});
