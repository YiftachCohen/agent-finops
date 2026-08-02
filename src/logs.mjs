import { createReadStream, readdirSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { relative, join, sep } from "node:path";
import { fingerprint, recordFromClaudeRawLine, toolNamesFromClaudeRawLine } from "./records.mjs";

/** Discover local Claude Code JSONL files without opening their content. */
export function findClaudeJsonl(root) {
  const paths = [];
  const walk = (current) => {
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && path.endsWith(".jsonl")) paths.push(path);
    }
  };
  walk(root);
  return paths.map((path) => {
    try {
      const stat = statSync(path);
      const firstSegment = relative(root, path).split(sep)[0] || "<root>";
      return {
        path,
        source: fingerprint(path),
        project: fingerprint(firstSegment),
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      };
    } catch {
      return null;
    }
  }).filter(Boolean).sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
}

/** Stream a file and return only accounting records plus a count of malformed rows. */
export async function readClaudeRecords(file) {
  const records = [];
  let parseErrors = 0;
  let pendingTools = [];
  try {
    const lines = createInterface({ input: createReadStream(file.path), crlfDelay: Infinity });
    for await (const raw of lines) {
      if (!raw.trim()) continue;
      const toolNames = toolNamesFromClaudeRawLine(raw);
      const record = recordFromClaudeRawLine(raw, file);
      if (record?.parseError) parseErrors++;
      else if (record) {
        // A tool result is represented by a user-side event between assistant
        // records. Attribute the next billed assistant request to the safe tool
        // names called immediately beforehand, not to transcript content.
        if (pendingTools.length) record.priorTools = pendingTools;
        records.push(record);
        pendingTools = toolNames;
      } else if (toolNames.length) {
        // Some tool-use events have no billing payload of their own. They still
        // describe the cohort whose following request we can measure.
        pendingTools = toolNames;
      }
    }
  } catch {
    parseErrors++;
  }
  return { records, parseErrors };
}
