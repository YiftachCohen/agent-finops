// Persistent local metadata index. It deliberately holds only the normalized
// accounting records produced by records.mjs: no paths and no transcript text.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { readClaudeRecords } from "./logs.mjs";
import { fingerprint } from "./records.mjs";

// Version 2 adds safe tool names and their immediate-follow-on attribution.
// Re-indexing is intentional so earlier indexes cannot silently omit it.
const VERSION = 2;

export function defaultIndexPath() {
  return join(homedir(), ".local", "share", "agent-finops", "index.json");
}

function emptyIndex() {
  return { version: VERSION, files: {}, tags: {} };
}

function metadataRecord(record) {
  return {
    provider: "claude",
    source: record.source,
    project: record.project,
    // Request/message identifiers are only useful for equality-based streaming
    // deduplication, so persist a one-way local fingerprint instead of the raw id.
    messageId: record.messageId ? fingerprint(record.messageId) : null,
    requestId: record.requestId ? fingerprint(record.requestId) : null,
    model: record.model,
    timestamp: record.timestamp,
    tools: Array.isArray(record.tools) ? record.tools : [],
    priorTools: Array.isArray(record.priorTools) ? record.priorTools : [],
    usage: record.usage,
  };
}

export function loadIndex(indexPath) {
  if (!existsSync(indexPath)) return emptyIndex();
  try {
    const parsed = JSON.parse(readFileSync(indexPath, "utf8"));
    if (parsed?.version !== VERSION || !parsed.files || !parsed.tags) return emptyIndex();
    return parsed;
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

/** Reuses unchanged log files and re-ingests only new or modified files. */
export async function updateIndex(index, files) {
  const nextFiles = {};
  let filesParsed = 0;
  let filesReused = 0;
  let parseErrors = 0;
  for (const file of files) {
    const previous = index.files[file.source];
    if (previous && previous.mtimeMs === file.mtimeMs && previous.size === file.size) {
      nextFiles[file.source] = previous;
      filesReused++;
      continue;
    }
    const read = await readClaudeRecords(file);
    nextFiles[file.source] = {
      mtimeMs: file.mtimeMs,
      size: file.size,
      project: file.project,
      records: read.records.map(metadataRecord),
    };
    filesParsed++;
    parseErrors += read.parseErrors;
  }
  const next = { ...index, version: VERSION, files: nextFiles, scannedAt: new Date().toISOString() };
  return { index: next, records: Object.values(nextFiles).flatMap((file) => file.records), stats: { filesSeen: files.length, filesParsed, filesReused, parseErrors } };
}

export function indexedRecords(index) {
  return Object.values(index.files).flatMap((file) => Array.isArray(file.records) ? file.records : []);
}

export function saveTag(index, name, report) {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name)) throw new Error("Tag names use letters, numbers, dots, underscores, and dashes only.");
  index.tags[name] = {
    taggedAt: new Date().toISOString(),
    scope: report.scope,
    total: report.total,
    byModel: report.byModel,
    insights: report.insights,
  };
  return index.tags[name];
}
