import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findClaudeJsonl } from "../src/logs.mjs";
import { fingerprint } from "../src/records.mjs";
import { indexedRecords, loadIndex, pruneRetired, saveIndex, saveTag, updateIndex } from "../src/index.mjs";
import { buildReport, compareSnapshots, humanComparison } from "../src/report.mjs";

const SECRET = "NEVER-PERSIST-THIS-PROMPT";

/**
 * One scan, the way the CLI performs it: the index is loaded first because the
 * salt it carries is what every path and project fingerprint is hashed with.
 */
async function scan(indexPath, logsDir) {
  const index = loadIndex(indexPath);
  return updateIndex(index, findClaudeJsonl(logsDir, index.salt));
}

test("index stores whitelisted metadata and reuses an unchanged file", async () => {
  const root = join(tmpdir(), `agent-finops-index-${process.pid}-${Date.now()}`);
  const indexPath = join(root, "private", "index.json");
  try {
    mkdirSync(join(root, "logs", "project"), { recursive: true });
    const log = join(root, "logs", "project", "session.jsonl");
    writeFileSync(log, `{"type":"message","requestId":"raw-request-id","timestamp":"2026-08-01T10:00:00Z","message":{"id":"raw-message-id","role":"assistant","model":"claude-sonnet-4-6","content":"${SECRET}","usage":{"input_tokens":3,"output_tokens":7}}}`);
    const first = await scan(indexPath, join(root, "logs"));
    saveIndex(indexPath, first.index);
    const saved = readFileSync(indexPath, "utf8");
    assert.ok(!saved.includes(SECRET));
    assert.ok(!saved.includes("raw-request-id"));
    assert.ok(!saved.includes("raw-message-id"));
    assert.equal(first.records.length, 1);
    assert.equal(first.stats.filesParsed, 1);
    const second = await scan(indexPath, join(root, "logs"));
    assert.equal(second.stats.filesReused, 1);
    assert.equal(second.stats.filesParsed, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a session file that grew is read from where the last scan stopped", async () => {
  const root = join(tmpdir(), `agent-finops-append-${process.pid}-${Date.now()}`);
  const indexPath = join(root, "private", "index.json");
  const turn = (n) => `{"type":"assistant","requestId":"r${n}","timestamp":"2026-08-01T10:0${n}:00Z","message":{"id":"m${n}","model":"claude-sonnet-4-6","content":"${SECRET}","usage":{"input_tokens":10,"output_tokens":5}}}\n`;
  try {
    mkdirSync(join(root, "logs", "project"), { recursive: true });
    const log = join(root, "logs", "project", "session.jsonl");
    writeFileSync(log, turn(1));
    const first = await scan(indexPath, join(root, "logs"));
    saveIndex(indexPath, first.index);
    assert.equal(first.records.length, 1);

    // Claude Code appends to an open session. The rescan must add the new turn
    // without re-reading and re-appending the one already indexed.
    writeFileSync(log, turn(1) + turn(2));
    const second = await scan(indexPath, join(root, "logs"));
    assert.equal(second.stats.filesAppended, 1);
    assert.equal(second.stats.filesParsed, 0);
    assert.equal(second.records.length, 2);
    assert.deepEqual(second.records.map((r) => r.timestamp), ["2026-08-01T10:01:00Z", "2026-08-01T10:02:00Z"]);

    // A file that shrank was rewritten, not appended to, so it is re-read whole.
    writeFileSync(log, turn(3));
    const third = await scan(indexPath, join(root, "logs"));
    assert.equal(third.stats.filesParsed, 1);
    assert.equal(third.stats.filesAppended, 0);
    assert.equal(third.records.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a version change rebuilds cached records but keeps user snapshots", () => {
  const root = join(tmpdir(), `agent-finops-tags-${process.pid}-${Date.now()}`);
  const indexPath = join(root, "index.json");
  try {
    // An index written by an older version, holding a tag the user took.
    mkdirSync(root, { recursive: true });
    writeFileSync(indexPath, JSON.stringify({
      version: 1,
      files: { abc: { records: [{ model: "claude-sonnet-4-6" }] } },
      tags: { baseline: { taggedAt: "2026-07-01T00:00:00Z", total: { usd: 1 } } },
    }));
    const loaded = loadIndex(indexPath);
    assert.deepEqual(loaded.files, {}, "stale records must be rebuilt");
    assert.ok(loaded.tags.baseline, "a snapshot the user took cannot be regenerated, so it is kept");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the saved index is private to the user and survives a corrupt file", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-finops-index-mode-"));
  const indexPath = join(root, "state", "index.json");
  try {
    saveIndex(indexPath, { version: 99, files: {}, tags: {} });
    // The index holds a full local usage history. Group- or world-readable is
    // not acceptable on a shared workstation.
    assert.equal(statSync(indexPath).mode & 0o777, 0o600);
    assert.equal(statSync(join(root, "state")).mode & 0o777, 0o700);
    assert.equal(existsSync(`${indexPath}.tmp`), false, "the atomic write leaves no temp file behind");

    // A half-written or hand-edited index must rebuild rather than throw: the
    // records are derived data and the next scan recreates them.
    writeFileSync(indexPath, '{"version":4,"files":{"a":{"records":[]}');
    const corrupt = loadIndex(indexPath);
    assert.deepEqual(corrupt.files, {});
    assert.deepEqual(corrupt.tags, {});

    // A parseable index whose `tags` is not an object cannot carry snapshots.
    writeFileSync(indexPath, JSON.stringify({ version: 1, files: {}, tags: ["not-an-object"] }));
    assert.deepEqual(loadIndex(indexPath).tags, {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a tag name that is not a tag name is refused", () => {
  const index = { tags: {} };
  const report = { scope: {}, total: { usd: 1, usage: { total: 1 } }, byModel: {}, insights: {} };
  for (const name of ["", "has space", "-leading-dash", "../escape", "a".repeat(65), "tag/../../x"]) {
    assert.throws(() => saveTag(index, name, report), /Tag names use letters/, JSON.stringify(name));
  }
  assert.deepEqual(Object.keys(index.tags), []);
  assert.ok(saveTag(index, "baseline-24h.v2", report));
});

test("comparing snapshots priced by different rate tables says so", () => {
  const index = { tags: {} };
  const report = { scope: {}, total: { usd: 10, usage: { total: 1 } }, byModel: {}, insights: {} };
  const current = saveTag(index, "current", report);
  const legacy = { ...current, pricing: undefined };

  const straddling = compareSnapshots("legacy", legacy, "current", current);
  assert.equal(straddling.pricingMismatch, true);
  assert.match(humanComparison(straddling), /pricing correction, not a change in spending/);

  const consistent = compareSnapshots("a", current, "b", current);
  assert.equal(consistent.pricingMismatch, false);
  assert.doesNotMatch(humanComparison(consistent), /pricing correction/);
});

test("a resumed scan re-reads the uncommitted final line without duplicating it", async () => {
  const root = join(tmpdir(), `agent-finops-tail-${process.pid}-${Date.now()}`);
  const indexPath = join(root, "private", "index.json");
  const turn = (n) => `{"type":"assistant","requestId":"r${n}","timestamp":"2026-08-01T10:0${n}:00Z","message":{"id":"m${n}","model":"claude-sonnet-4-6","content":"${SECRET}","usage":{"input_tokens":10,"output_tokens":5}}}`;
  const timestamps = (result) => indexedRecords(result.index).map((entry) => entry.timestamp);
  try {
    mkdirSync(join(root, "logs", "project"), { recursive: true });
    const log = join(root, "logs", "project", "session.jsonl");

    // Two committed lines plus a third the writer has not terminated yet. The
    // third turn must be reported now, but the scan cannot commit past it.
    writeFileSync(log, `${turn(1)}\n${turn(2)}\n${turn(3)}`);
    const first = await scan(indexPath, join(root, "logs"));
    saveIndex(indexPath, first.index);
    assert.deepEqual(timestamps(first), ["2026-08-01T10:01:00Z", "2026-08-01T10:02:00Z", "2026-08-01T10:03:00Z"]);

    // The writer finishes that line. The resumed read produces it a second
    // time, so the stored tail must be replaced rather than appended to.
    writeFileSync(log, `${turn(1)}\n${turn(2)}\n${turn(3)}\n`);
    const second = await scan(indexPath, join(root, "logs"));
    assert.equal(second.stats.filesAppended, 1);
    assert.deepEqual(timestamps(second), ["2026-08-01T10:01:00Z", "2026-08-01T10:02:00Z", "2026-08-01T10:03:00Z"]);

    // A fourth turn appends normally on top of the now-committed third.
    writeFileSync(log, `${turn(1)}\n${turn(2)}\n${turn(3)}\n${turn(4)}\n`);
    const third = await scan(indexPath, join(root, "logs"));
    assert.equal(timestamps(third).length, 4);
    assert.equal(new Set(timestamps(third)).size, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unterminated final line is counted once, not duplicated by the next scan", async () => {
  const root = join(tmpdir(), `agent-finops-partial-${process.pid}-${Date.now()}`);
  const indexPath = join(root, "private", "index.json");
  try {
    mkdirSync(join(root, "logs", "project"), { recursive: true });
    const log = join(root, "logs", "project", "session.jsonl");
    const complete = `{"type":"assistant","requestId":"r1","timestamp":"2026-08-01T10:01:00Z","message":{"id":"m1","model":"claude-sonnet-4-6","content":"${SECRET}","usage":{"input_tokens":10,"output_tokens":5}}}`;
    writeFileSync(log, complete);
    const first = await scan(indexPath, join(root, "logs"));
    saveIndex(indexPath, first.index);
    assert.equal(first.records.length, 1);

    // The writer finishes the line. The turn must not be indexed a second time.
    writeFileSync(log, `${complete}\n`);
    const second = await scan(indexPath, join(root, "logs"));
    assert.equal(second.records.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * One assistant message can straddle a scan boundary: the writer emits the first
 * `tool_use` line, the scan commits past it, and the sibling block arrives later.
 * The resumed read has to recognise that the next line continues the message it
 * stopped inside, which it does from a salted fingerprint rather than a stored id.
 */
const MESSAGE_ID = "msg_DISTINCTIVE_SYNTHETIC_GROUP_ID_9999";
const parallelCall = (name, id) =>
  `{"type":"assistant","requestId":"r-call","timestamp":"2026-08-01T10:00:00Z","message":{"id":"${MESSAGE_ID}","model":"claude-sonnet-4-6","content":[{"type":"tool_use","id":"${id}","name":"${name}","input":{"command":"${SECRET}"}}],"usage":{"input_tokens":1,"output_tokens":1}}}`;
const parallelLog = [
  parallelCall("Bash", "call-1"),
  parallelCall("Read", "call-2"),
  `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-1","content":"${SECRET}"}]}}`,
  `{"type":"assistant","requestId":"r-follow","timestamp":"2026-08-01T10:01:00Z","message":{"id":"m-follow","model":"claude-sonnet-4-6","content":"${SECRET}","usage":{"input_tokens":100,"output_tokens":20}}}`,
  "",
].join("\n");

test("a scan that stops inside an assistant message rebuilds the cohort a single pass would have", async () => {
  const root = join(tmpdir(), `agent-finops-cohort-resume-${process.pid}-${Date.now()}`);
  const indexPath = join(root, "private", "index.json");
  const onePassPath = join(root, "one-pass", "index.json");
  const priorTools = (result) => indexedRecords(result.index).map((record) => record.priorTools);
  try {
    mkdirSync(join(root, "logs", "project"), { recursive: true });
    mkdirSync(join(root, "one-pass-logs", "project"), { recursive: true });
    const log = join(root, "logs", "project", "session.jsonl");

    // The first tool_use line is terminated; the second is still being written.
    writeFileSync(log, `${parallelCall("Bash", "call-1")}\n${parallelCall("Read", "call-2")}`);
    const first = await scan(indexPath, join(root, "logs"));
    saveIndex(indexPath, first.index);

    writeFileSync(log, parallelLog);
    const resumed = await scan(indexPath, join(root, "logs"));
    saveIndex(indexPath, resumed.index);
    assert.equal(resumed.stats.filesAppended, 1);

    const onePassLog = join(root, "one-pass-logs", "project", "session.jsonl");
    writeFileSync(onePassLog, parallelLog);
    const onePass = await scan(onePassPath, join(root, "one-pass-logs"));

    assert.deepEqual(priorTools(resumed), [[], [], ["Bash", "Read"]]);
    assert.deepEqual(priorTools(resumed), priorTools(onePass));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the message a resumed cohort belongs to is stored as a salted fingerprint, never as an id", async () => {
  const root = join(tmpdir(), `agent-finops-group-id-${process.pid}-${Date.now()}`);
  const indexPath = join(root, "private", "index.json");
  try {
    mkdirSync(join(root, "logs", "project"), { recursive: true });
    const log = join(root, "logs", "project", "session.jsonl");
    // Stopping mid-message is what forces the group identity to be persisted.
    writeFileSync(log, `${parallelCall("Bash", "call-1")}\n${parallelCall("Read", "call-2")}`);
    const first = await scan(indexPath, join(root, "logs"));
    saveIndex(indexPath, first.index);

    const saved = readFileSync(indexPath, "utf8");
    assert.ok(!saved.includes(SECRET));
    assert.ok(!saved.includes(MESSAGE_ID), "a raw message id is transcript-adjacent metadata and never persists");
    // It is there, but only one way: the same salted fingerprint the resumed
    // read recomputes from the line it lexes.
    assert.ok(saved.includes(fingerprint(MESSAGE_ID, first.index.salt)));

    // And the salt that makes it stays behind: nothing a user shares carries it.
    const report = buildReport(indexedRecords(loadIndex(indexPath)));
    assert.ok(!JSON.stringify(report).includes(first.index.salt));
    assert.ok(!JSON.stringify(report).includes(MESSAGE_ID));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a log file Claude Code deleted keeps its records instead of dropping the spend", async () => {
  const root = join(tmpdir(), `agent-finops-retired-${process.pid}-${Date.now()}`);
  const indexPath = join(root, "private", "index.json");
  const logs = join(root, "logs");
  const turn = (id, output) => `{"type":"assistant","requestId":"${id}","timestamp":"2026-08-01T10:00:00Z","message":{"id":"${id}","model":"claude-sonnet-4-6","content":"${SECRET}","usage":{"input_tokens":10,"output_tokens":${output}}}}\n`;
  try {
    mkdirSync(join(logs, "project"), { recursive: true });
    const kept = join(logs, "project", "kept.jsonl");
    const deleted = join(logs, "project", "deleted.jsonl");
    writeFileSync(kept, turn("r1", 5));
    writeFileSync(deleted, turn("r2", 25));
    const first = await scan(indexPath, logs);
    saveIndex(indexPath, first.index);
    assert.equal(first.records.length, 2);
    const spend = buildReport(first.records).total.usd;

    // Claude Code prunes its own transcripts on its own schedule. The index is
    // then the only remaining evidence of that session's spend, so retiring the
    // source must leave every report exactly where it was.
    rmSync(deleted);
    const second = await scan(indexPath, logs);
    saveIndex(indexPath, second.index);
    assert.equal(second.stats.filesRetired, 1);
    assert.equal(second.records.length, 2);
    assert.equal(buildReport(second.records).total.usd, spend);
    assert.equal(buildReport(indexedRecords(loadIndex(indexPath))).total.usd, spend);

    // A retired entry holds exactly what a live entry holds: metadata records
    // and the scan timestamp that retired them. No path, no transcript text.
    const retired = loadIndex(indexPath).retired;
    assert.deepEqual(Object.keys(retired).map((id) => /^[a-f0-9]{12}$/.test(id)), [true]);
    assert.deepEqual(Object.keys(Object.values(retired)[0]).sort(), ["records", "retiredAt"]);
    assert.ok(!readFileSync(indexPath, "utf8").includes(SECRET));

    // A later scan keeps it retired rather than retiring it twice or losing it.
    const third = await scan(indexPath, logs);
    assert.equal(third.stats.filesRetired, 0);
    assert.equal(third.records.length, 2);
    assert.equal(buildReport(third.records).total.usd, spend);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a retired session whose log file comes back is read live, not counted twice", async () => {
  const root = join(tmpdir(), `agent-finops-return-${process.pid}-${Date.now()}`);
  const indexPath = join(root, "private", "index.json");
  const logs = join(root, "logs");
  const line = `{"type":"assistant","requestId":"r1","timestamp":"2026-08-01T10:00:00Z","message":{"id":"m1","model":"claude-sonnet-4-6","usage":{"input_tokens":10,"output_tokens":5}}}\n`;
  try {
    mkdirSync(join(logs, "project"), { recursive: true });
    const anchor = join(logs, "project", "anchor.jsonl");
    const flapping = join(logs, "project", "flapping.jsonl");
    writeFileSync(anchor, line.replace(/r1|m1/g, "anchor"));
    writeFileSync(flapping, line);
    saveIndex(indexPath, (await scan(indexPath, logs)).index);

    rmSync(flapping);
    const retiredScan = await scan(indexPath, logs);
    saveIndex(indexPath, retiredScan.index);
    assert.equal(Object.keys(retiredScan.index.retired).length, 1);

    // Restored under the same path, so under the same salted id. The live read
    // is ground truth and replaces the retired copy rather than adding to it.
    writeFileSync(flapping, line);
    const returned = await scan(indexPath, logs);
    assert.deepEqual(Object.keys(returned.index.retired), []);
    assert.equal(returned.records.length, 2);
    assert.equal(buildReport(returned.records).total.requests, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a version change preserves retired history and the salt it was written with", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-finops-retired-version-"));
  const indexPath = join(root, "index.json");
  try {
    writeFileSync(indexPath, JSON.stringify({
      version: 1,
      salt: "fixture-salt-0123456789",
      files: { aabbccddeeff: { records: [{ source: "aabbccddeeff", model: "claude-sonnet-4-6", timestamp: "2026-07-01T00:00:00Z", usage: { input: 1, output: 1 } }] } },
      retired: { "112233445566": { retiredAt: "2026-07-02T00:00:00Z", records: [{ source: "112233445566", project: "665544332211", model: "claude-sonnet-4-6", timestamp: "2026-07-01T00:00:00Z", usage: { input: 10, output: 5 } }] } },
      tags: { baseline: { taggedAt: "2026-07-01T00:00:00Z", total: { usd: 1 } } },
    }));
    const loaded = loadIndex(indexPath);
    assert.equal(loaded.version, 6);
    assert.deepEqual(loaded.files, {}, "records for a file that still exists are rebuilt from it");
    assert.ok(loaded.tags.baseline, "a snapshot the user took cannot be regenerated");
    // Retired records have no source file left, so a rebuild cannot recreate
    // them, and re-salting would orphan both them and the project labels.
    assert.equal(loaded.retired["112233445566"].records.length, 1);
    assert.equal(loaded.salt, "fixture-salt-0123456789");
    assert.equal(indexedRecords(loaded).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a retired record is rebuilt from the metadata allowlist every time it loads", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-finops-retired-shape-"));
  const indexPath = join(root, "index.json");
  try {
    // Retired records outlive the version that wrote them, so loading them is
    // the last place their shape can be checked. Anything outside the allowlist
    // — here a field an older or hand-edited index left behind — must not ride
    // along into a report or the dashboard.
    writeFileSync(indexPath, JSON.stringify({
      version: 6,
      salt: "fixture-salt-0123456789",
      files: {},
      tags: {},
      retired: {
        "112233445566": {
          retiredAt: "not a timestamp",
          records: [{
            source: "112233445566",
            cwd: `/synthetic/example/${SECRET}`,
            model: "\u001b[31mclaude-sonnet-4-6",
            timestamp: "not a timestamp",
            tools: ["Bash", "../../etc/passwd"],
            // A cohort of more than one tool is now the normal case, and every
            // entry in it is still checked against the tool-name allowlist.
            priorTools: ["Bash", "Read", `cat ${SECRET}`],
            usage: { input: -5, output: 7 },
          }],
        },
        "not-a-fingerprint": { records: [{ source: "whatever" }] },
        aabbccddeeff: { records: [] },
      },
    }));
    const loaded = loadIndex(indexPath);
    assert.deepEqual(Object.keys(loaded.retired), ["112233445566"], "a key that is not an anonymous id, and an empty entry, are dropped");
    const entry = loaded.retired["112233445566"];
    assert.equal(entry.retiredAt, null);
    const [record] = entry.records;
    assert.equal(record.model, "<unknown>");
    assert.equal(record.timestamp, null);
    assert.deepEqual(record.tools, ["Bash"]);
    assert.deepEqual(record.priorTools, ["Bash", "Read"]);
    assert.equal(record.usage.input, 0);
    assert.equal(record.usage.output, 7);
    assert.equal(record.project, null);
    assert.ok(!Object.hasOwn(record, "cwd"), "a field outside the allowlist cannot ride along");
    assert.ok(!JSON.stringify(loaded).includes(SECRET));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prune-index drops only retired records past the cutoff", () => {
  const now = Date.parse("2026-08-02T00:00:00Z");
  const record = (timestamp) => ({ source: "112233445566", model: "claude-sonnet-4-6", timestamp, usage: { input: 1, output: 1 } });
  const index = {
    retired: {
      "112233445566": { retiredAt: "2026-08-01T00:00:00Z", records: [record("2026-01-01T00:00:00Z"), record("2026-08-01T00:00:00Z"), record(null)] },
      "665544332211": { retiredAt: "2026-08-01T00:00:00Z", records: [record("2026-01-02T00:00:00Z")] },
    },
  };
  // Thirty days back from a fixed `now`. A record with no usable timestamp
  // cannot be placed in any window, so it counts as older than every cutoff
  // instead of being immortal.
  const removed = pruneRetired(index, { olderThanMs: 30 * 86_400_000, now });
  assert.equal(removed.removedRecords, 3);
  assert.equal(removed.removedSources, 1);
  assert.equal(removed.remainingRecords, 1);
  assert.deepEqual(Object.keys(index.retired), ["112233445566"]);
  assert.deepEqual(index.retired["112233445566"].records.map((entry) => entry.timestamp), ["2026-08-01T00:00:00Z"]);
  assert.equal(index.retired["112233445566"].retiredAt, "2026-08-01T00:00:00Z", "the entry keeps when it was retired");

  // History is never deleted on a guess: the duration has to be a real one.
  for (const bad of [0, -1, Number.NaN, Infinity, undefined]) {
    assert.throws(() => pruneRetired({ retired: {} }, { olderThanMs: bad }), /positive duration/, String(bad));
  }
});

test("session and project ids differ under different salts", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-finops-salted-"));
  try {
    mkdirSync(join(root, "acme-billing"), { recursive: true });
    writeFileSync(join(root, "acme-billing", "session.jsonl"), "");
    const [left] = findClaudeJsonl(root, "fixture-salt-left-0123456789");
    const [right] = findClaudeJsonl(root, "fixture-salt-right-0123456789");
    const [unsalted] = findClaudeJsonl(root);
    // The pre-images are a home path and a repository name, both guessable, so
    // an unsalted id is a confirm-or-deny oracle on any shared report.
    assert.notEqual(left.source, right.source);
    assert.notEqual(left.project, right.project);
    assert.notEqual(left.source, unsalted.source);
    assert.deepEqual(findClaudeJsonl(root, "fixture-salt-left-0123456789")[0], left);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
