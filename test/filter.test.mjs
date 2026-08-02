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

test("compressor keeps the tail when head lines are long", () => {
  // A build log whose lines are wide enough that head + tail alone overflow the
  // budget. The failure summary lives at the end, so it must survive.
  const wide = Array.from({ length: 300 }, (_, i) => `L${i} ${"y".repeat(300)}`).join("\n");
  const result = compactStdout(wide);
  assert.equal(result.changed, true);
  assert.ok(result.sentChars <= 12_000);
  assert.ok(result.stdout.startsWith("L0 "), "head is preserved");
  assert.match(result.stdout, /L299 /, "tail is preserved");
});

test("compressor keeps both ends of a single enormous line", () => {
  const result = compactStdout(`START${"x".repeat(60_000)}END`);
  assert.ok(result.stdout.startsWith("START"));
  assert.ok(result.stdout.endsWith("END"));
  assert.ok(result.sentChars <= 12_000);
});

test("omitted-line count reflects positions, not distinct strings", () => {
  // 900 lines drawn from only 3 distinct strings. Counting a Set of strings
  // would report nearly every line as omitted.
  const repetitive = Array.from({ length: 900 }, (_, i) => `repeated variant ${i % 3}`).join("\n");
  const result = compactStdout(repetitive);
  assert.equal(result.elidedLines, 900 - 60 - 60);
});

test("non-Bash and image results are left untouched", () => {
  assert.equal(processPostToolUse({ tool_name: "Read", tool_response: { stdout: noisyOutput() } }, "/tmp/unused"), null);
  assert.equal(processPostToolUse({ tool_name: "Bash", tool_response: { stdout: noisyOutput(), isImage: true } }, "/tmp/unused"), null);
});
