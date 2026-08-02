import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compactStdout, filterReport, processPostToolUse, readArtifact } from "../src/filter.mjs";

function noisyOutput() {
  return [
    ...Array.from({ length: 90 }, (_, i) => `setup line ${i}`),
    "ERROR src/auth.ts:42 assertion failed",
    ...Array.from({ length: 2400 }, (_, i) => `verbose framework line ${i} xxxxxxxxxxxxxxxxxxxxxxxxx`),
    ...Array.from({ length: 90 }, (_, i) => `final line ${i}`),
  ].join("\n");
}

test("compressor keeps short output byte-for-byte", () => {
  const result = compactStdout("exact\nsmall\noutput");
  assert.equal(result.changed, false);
  assert.equal(result.stdout, "exact\nsmall\noutput");
});

test("hook replaces only noisy stdout, preserves stderr, and retains a private artifact", () => {
  const home = mkdtempSync(join(tmpdir(), "agent-finops-filter-"));
  try {
    const raw = noisyOutput();
    const result = processPostToolUse({
      tool_name: "Bash",
      session_id: "raw-session-id",
      cwd: "/private/project",
      tool_response: { stdout: raw, stderr: "warning kept on stderr", interrupted: false, isImage: false },
    }, home);
    assert.ok(result);
    const output = result.hookSpecificOutput.updatedToolOutput;
    assert.ok(output.stdout.length < raw.length);
    assert.match(output.stdout, /ERROR src\/auth.ts:42 assertion failed/);
    assert.equal(output.stderr, "warning kept on stderr");
    const id = /retained as ([a-z0-9-]+)/i.exec(output.stdout)?.[1];
    assert.ok(id);
    assert.equal(readArtifact(id, home).stdout, raw);
    assert.equal(statSync(join(home, "artifacts", `${id}.json`)).mode & 0o777, 0o600);
    const ledger = readFileSync(join(home, "history.jsonl"), "utf8");
    assert.ok(!ledger.includes("raw-session-id"));
    assert.ok(!ledger.includes("/private/project"));
    const metrics = filterReport({ home });
    assert.equal(metrics.events, 1);
    assert.ok(metrics.savedChars > 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("non-Bash and image results are left untouched", () => {
  assert.equal(processPostToolUse({ tool_name: "Read", tool_response: { stdout: noisyOutput() } }, "/tmp/unused"), null);
  assert.equal(processPostToolUse({ tool_name: "Bash", tool_response: { stdout: noisyOutput(), isImage: true } }, "/tmp/unused"), null);
});
