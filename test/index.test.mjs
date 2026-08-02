import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findClaudeJsonl } from "../src/logs.mjs";
import { loadIndex, saveIndex, updateIndex } from "../src/index.mjs";

const SECRET = "NEVER-PERSIST-THIS-PROMPT";

test("index stores whitelisted metadata and reuses an unchanged file", async () => {
  const root = join(tmpdir(), `agent-finops-index-${process.pid}-${Date.now()}`);
  const indexPath = join(root, "private", "index.json");
  try {
    mkdirSync(join(root, "logs", "project"), { recursive: true });
    const log = join(root, "logs", "project", "session.jsonl");
    writeFileSync(log, `{"type":"message","requestId":"raw-request-id","timestamp":"2026-08-01T10:00:00Z","message":{"id":"raw-message-id","role":"assistant","model":"claude-sonnet-4-6","content":"${SECRET}","usage":{"input_tokens":3,"output_tokens":7}}}`);
    const first = await updateIndex(loadIndex(indexPath), findClaudeJsonl(join(root, "logs")));
    saveIndex(indexPath, first.index);
    const saved = readFileSync(indexPath, "utf8");
    assert.ok(!saved.includes(SECRET));
    assert.ok(!saved.includes("raw-request-id"));
    assert.ok(!saved.includes("raw-message-id"));
    assert.equal(first.records.length, 1);
    assert.equal(first.stats.filesParsed, 1);
    const second = await updateIndex(loadIndex(indexPath), findClaudeJsonl(join(root, "logs")));
    assert.equal(second.stats.filesReused, 1);
    assert.equal(second.stats.filesParsed, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
