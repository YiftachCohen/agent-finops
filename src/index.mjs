// Persistent local metadata index. It deliberately holds only the normalized
// accounting records produced by records.mjs: no paths and no transcript text.

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { readClaudeRecords } from "./logs.mjs";
import { fingerprint, isSafeModelId, isSafeToolName } from "./records.mjs";
import { PRICING_VERSION } from "./rates.mjs";

// Version 2 adds safe tool names and their immediate-follow-on attribution.
// Version 3 adds the per-TTL cache-write split, which corrects the cost of
// 1-hour cache writes, plus the resume offset that lets a scan append to a
// growing session file instead of re-reading it. Re-indexing is intentional so
// earlier indexes cannot silently keep the old, understated estimate.
// Version 4 stores the records read from an uncommitted final line under
// `tailRecords`, apart from the committed ones. A version-3 index folded them
// into `records` while the resume offset stayed behind that line, so every
// rescan appended the same turn again.
// Version 5 adds the `retired` section and a per-install `salt`. Together they
// change what a version bump means: cached records for a log file that still
// exists are still discarded and rebuilt from that file, but `tags`, `retired`,
// and `salt` are carried across untouched. A retired record's log file is gone,
// so it can never be re-derived, and re-salting would orphan both the retired
// entries and the project labels keyed by the old ids.
// Version 6 groups a tool cohort by assistant message id instead of by log line,
// and the scan state it resumes from changes with it: `pendingTools` becomes
// `cohortTools`, `currentTools`, and the salted `messageGroup` fingerprint of the
// message still being read. Every `priorTools` a version-5 index holds is a
// singleton, because each streamed `tool_use` line overwrote the previous one, so
// a rebuild is the point rather than a side effect. The same grouping fixes
// `tools`, which is now the message's blocks rather than the line's: streaming
// deduplication keeps the last row of a message, so a version-5 record dropped
// every `tool_use` block written before it and undercounted calls. Both fields
// stay allowlisted tool-name arrays — only their cardinality changes — so no
// stored shape changes with them. `tags`, `retired`, and `salt` are carried
// across as always, which means retired records keep their old single-tool
// cohorts and undercounted calls, since their log files are gone and nothing can
// re-derive the parallel blocks that were lost.
const VERSION = 6;

// A fingerprint as this file writes it: 12 lowercase hex characters. Stored ids
// are re-checked against it, which is also what keeps a hand-edited index from
// introducing a section key that is not an anonymous id.
const FINGERPRINT_RE = /^[a-f0-9]{12}$/;

export function defaultIndexPath() {
  return join(homedir(), ".local", "share", "agent-finops", "index.json");
}

/**
 * A fresh per-install salt. Path and project fingerprints are short hashes of
 * low-entropy, highly structured pre-images — a home directory, a repository
 * name — so an unsalted id permits cheap confirm-or-deny of a username or repo
 * from a shared report. The salt never leaves the 0600 index file.
 */
function newSalt() {
  return randomBytes(32).toString("hex");
}

/** A stored salt is usable when it is a bounded string; anything else is replaced. */
function usableSalt(value) {
  return typeof value === "string" && value.length >= 16 && value.length <= 512 ? value : null;
}

function emptyIndex(salt = newSalt()) {
  return { version: VERSION, salt, files: {}, retired: {}, tags: {} };
}

function metadataRecord(record, salt) {
  return {
    provider: "claude",
    source: record.source,
    project: record.project,
    // Request/message identifiers are only useful for equality-based streaming
    // deduplication, so persist a one-way local fingerprint instead of the raw id.
    messageId: record.messageId ? fingerprint(record.messageId, salt) : null,
    requestId: record.requestId ? fingerprint(record.requestId, salt) : null,
    model: record.model,
    timestamp: record.timestamp,
    tools: Array.isArray(record.tools) ? record.tools : [],
    priorTools: Array.isArray(record.priorTools) ? record.priorTools : [],
    usage: record.usage,
  };
}

function counter(value) {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function storedFingerprint(value) {
  return typeof value === "string" && FINGERPRINT_RE.test(value) ? value : null;
}

function safeToolNames(value) {
  return Array.isArray(value) ? value.filter(isSafeToolName) : [];
}

/**
 * Rebuild one stored record field by field. Retired records outlive the VERSION
 * that wrote them and their log file is gone, so loading them is the only place
 * their shape can still be checked. Every field is reconstructed from the
 * allowlist `metadataRecord` uses, which drops anything an older — or
 * hand-edited — index left beside them and supplies the defaults for the rest.
 */
function normalizeStoredRecord(record, source) {
  const usage = record?.usage;
  return {
    provider: "claude",
    source: storedFingerprint(record?.source) || source,
    project: storedFingerprint(record?.project),
    messageId: storedFingerprint(record?.messageId),
    requestId: storedFingerprint(record?.requestId),
    model: isSafeModelId(record?.model) ? record.model : "<unknown>",
    timestamp: typeof record?.timestamp === "string" && Number.isFinite(Date.parse(record.timestamp)) ? record.timestamp : null,
    tools: safeToolNames(record?.tools),
    priorTools: safeToolNames(record?.priorTools),
    usage: {
      input: counter(usage?.input),
      cacheCreate: counter(usage?.cacheCreate),
      cacheCreate1h: counter(usage?.cacheCreate1h),
      cacheCreate5m: counter(usage?.cacheCreate5m),
      cacheRead: counter(usage?.cacheRead),
      output: counter(usage?.output),
    },
  };
}

function normalizeRetired(value) {
  const retired = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return retired;
  for (const [source, entry] of Object.entries(value)) {
    if (!FINGERPRINT_RE.test(source)) continue;
    const records = Array.isArray(entry?.records) ? entry.records.map((record) => normalizeStoredRecord(record, source)) : [];
    if (!records.length) continue;
    const retiredAt = typeof entry?.retiredAt === "string" && Number.isFinite(Date.parse(entry.retiredAt)) ? entry.retiredAt : null;
    retired[source] = { retiredAt, records };
  }
  return retired;
}

export function loadIndex(indexPath) {
  if (!existsSync(indexPath)) return emptyIndex();
  try {
    const parsed = JSON.parse(readFileSync(indexPath, "utf8"));
    // Three sections outlive a version change. Tags are snapshots the user took
    // deliberately and cannot be regenerated; retired records describe log files
    // Claude Code has already deleted, so nothing can re-derive them either; and
    // the salt is what keeps every surviving id — and every project label —
    // meaning the same thing after the rebuild.
    const salt = usableSalt(parsed?.salt) || newSalt();
    const tags = parsed?.tags && typeof parsed.tags === "object" && !Array.isArray(parsed.tags) ? parsed.tags : {};
    const retired = normalizeRetired(parsed?.retired);
    // Tags keep the `pricing` stamp they were taken with; `compare` uses it to
    // flag a comparison that straddles a pricing fix.
    if (parsed?.version !== VERSION || !parsed.files || !parsed.tags) return { ...emptyIndex(salt), tags, retired };
    return { ...parsed, salt, tags, retired };
  } catch {
    return emptyIndex();
  }
}

export function saveIndex(indexPath, index) {
  const directory = dirname(indexPath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temp = `${indexPath}.tmp`;
  writeFileSync(temp, JSON.stringify(index), { encoding: "utf8", mode: 0o600 });
  renameSync(temp, indexPath);
  chmodSync(indexPath, 0o600);
}

/**
 * Decide whether a changed file can be read from where the last scan stopped.
 * Only a file that strictly grew qualifies: equal size with a new mtime, or a
 * shrunken file, means it was rewritten rather than appended to, and its earlier
 * bytes can no longer be trusted.
 *
 * The open cohort travels with the offset. `messageGroup` is the salted
 * fingerprint of the assistant message `currentTools` was being accumulated for,
 * never the id itself: the resumed read re-fingerprints the id it lexes and
 * compares, so a parallel tool call split across a scan boundary still lands in
 * one cohort without a raw message id ever reaching the index.
 */
function resumePoint(previous, file) {
  if (!previous || !Array.isArray(previous.records)) return null;
  if (!Number.isInteger(previous.offset) || previous.offset <= 0) return null;
  if (!Number.isFinite(previous.size) || file.size <= previous.size) return null;
  return {
    offset: previous.offset,
    cohortTools: safeToolNames(previous.cohortTools),
    currentTools: safeToolNames(previous.currentTools),
    messageGroup: storedFingerprint(previous.messageGroup),
  };
}

/**
 * Move the records of every source the walk no longer finds into `retired`.
 * Claude Code prunes its own transcripts on its own schedule; without this the
 * spend of a deleted session disappears from every report and the drop reads as
 * a real one. A source that comes back replaces its retired entry: the live read
 * is ground truth, and keep-last deduplication absorbs any overlap.
 */
function retireMissingSources(index, nextFiles, scannedAt) {
  const retired = { ...(index.retired || {}) };
  let filesRetired = 0;
  for (const [source, entry] of Object.entries(index.files || {})) {
    if (Object.hasOwn(nextFiles, source)) continue;
    const records = [...(Array.isArray(entry?.records) ? entry.records : []), ...(Array.isArray(entry?.tailRecords) ? entry.tailRecords : [])];
    if (!records.length) continue;
    retired[source] = { retiredAt: scannedAt, records };
    filesRetired++;
  }
  for (const source of Object.keys(nextFiles)) delete retired[source];
  return { retired, filesRetired };
}

/** Reuses unchanged log files and re-ingests only new or modified files. */
export async function updateIndex(index, files) {
  const salt = usableSalt(index.salt) || "";
  const nextFiles = {};
  let filesParsed = 0;
  let filesReused = 0;
  let filesAppended = 0;
  let parseErrors = 0;
  for (const file of files) {
    const previous = index.files?.[file.source];
    if (previous && previous.mtimeMs === file.mtimeMs && previous.size === file.size) {
      nextFiles[file.source] = previous;
      filesReused++;
      continue;
    }
    const resume = resumePoint(previous, file);
    const read = await readClaudeRecords(file, resume, salt);
    const parsed = read.records.map((record) => metadataRecord(record, salt));
    nextFiles[file.source] = {
      // A truncated read must not record the file's current mtime and size, or
      // the next scan would treat the partial result as complete. Storing the
      // offset actually reached lets that scan resume instead of restarting.
      mtimeMs: read.truncated ? null : file.mtimeMs,
      size: read.truncated ? read.offset : file.size,
      offset: read.offset,
      // The open cohort, as three fields rather than one list: the tools of the
      // last completed assistant message, the tools of the one still being read,
      // and a salted fingerprint of that message's id so the resumed read can
      // tell a continuation from a new message.
      cohortTools: read.cohortTools,
      currentTools: read.currentTools,
      messageGroup: read.messageGroup,
      project: file.project,
      // Only committed records accumulate. The previous scan's `tailRecords`
      // are deliberately dropped here: the resumed read starts before that line
      // and produced them again, so carrying them forward would double the turn.
      records: resume ? [...previous.records, ...parsed] : parsed,
      tailRecords: read.tailRecords.map((record) => metadataRecord(record, salt)),
    };
    if (resume) filesAppended++;
    else filesParsed++;
    parseErrors += read.parseErrors;
  }
  const scannedAt = new Date().toISOString();
  const { retired, filesRetired } = retireMissingSources(index, nextFiles, scannedAt);
  const next = { ...index, version: VERSION, salt, files: nextFiles, retired, scannedAt };
  return { index: next, records: indexedRecords(next), stats: { filesSeen: files.length, filesParsed, filesAppended, filesReused, filesRetired, parseErrors } };
}

/**
 * Every record the index holds. The uncommitted tail is included so the freshest
 * turn of an open session still appears in reports; it is stored separately only
 * so the next scan can replace it rather than append to it.
 *
 * Retired records come first so that if the same turn were ever present in both
 * sections, the live copy — read from a file that still exists — is the one
 * keep-last deduplication keeps.
 */
export function indexedRecords(index) {
  const retired = Object.values(index.retired || {}).flatMap((entry) => (Array.isArray(entry?.records) ? entry.records : []));
  const live = Object.values(index.files || {}).flatMap((file) => [
    ...(Array.isArray(file.records) ? file.records : []),
    ...(Array.isArray(file.tailRecords) ? file.tailRecords : []),
  ]);
  return [...retired, ...live];
}

/**
 * Drop retired records older than a cutoff, and any retired source left empty.
 * Retired history is the only part of the index that can never be rebuilt from
 * the logs, so it is never pruned automatically: silently deleting history is
 * the exact failure this section exists to prevent. A record with no usable
 * timestamp counts as older than any cutoff — it cannot be placed in a window,
 * so it would otherwise be immortal.
 */
export function pruneRetired(index, { olderThanMs, now = Date.now() } = {}) {
  if (!Number.isFinite(olderThanMs) || olderThanMs <= 0) throw new Error("prune-index needs a positive duration such as 90d.");
  const cutoff = now - olderThanMs;
  const retired = {};
  let removedRecords = 0;
  let removedSources = 0;
  let remainingRecords = 0;
  for (const [source, entry] of Object.entries(index.retired || {})) {
    const records = Array.isArray(entry?.records) ? entry.records : [];
    const kept = records.filter((record) => {
      const time = Date.parse(record?.timestamp || "");
      return Number.isFinite(time) && time >= cutoff;
    });
    removedRecords += records.length - kept.length;
    if (!kept.length) {
      removedSources++;
      continue;
    }
    retired[source] = { ...entry, records: kept };
    remainingRecords += kept.length;
  }
  index.retired = retired;
  return { cutoff: new Date(cutoff).toISOString(), removedRecords, removedSources, remainingRecords, remainingSources: Object.keys(retired).length };
}

export function saveTag(index, name, report) {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name)) throw new Error("Tag names use letters, numbers, dots, underscores, and dashes only.");
  index.tags[name] = {
    taggedAt: new Date().toISOString(),
    pricing: PRICING_VERSION,
    scope: report.scope,
    total: report.total,
    byModel: report.byModel,
    insights: report.insights,
  };
  return index.tags[name];
}
