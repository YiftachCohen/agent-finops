import { createReadStream, readdirSync, statSync } from "node:fs";
import { relative, join, sep } from "node:path";
import { fingerprint, isSafeMessageId, isSafeToolName, isToolResultLine, messageIdFromClaudeRawLine, recordFromClaudeRawLine, toolNamesFromClaudeRawLine } from "./records.mjs";

/**
 * Discover local Claude Code JSONL files without opening their content. The salt
 * comes from the index this walk will feed: session and project ids are hashes
 * of a path and a directory name, and both are guessable without it.
 */
export function findClaudeJsonl(root, salt = "") {
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
        source: fingerprint(path, salt),
        project: fingerprint(firstSegment, salt),
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      };
    } catch {
      return null;
    }
  }).filter(Boolean).sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
}

/**
 * Yield each line with the byte offset just past it, and whether it was
 * newline-terminated. Claude Code appends to a session file for as long as the
 * session is open, so a scan needs to resume from an exact byte position rather
 * than re-read from the start.
 */
async function* linesFrom(path, start) {
  let carry = null;
  let offset = start;
  for await (const chunk of createReadStream(path, { start })) {
    carry = carry?.length ? Buffer.concat([carry, chunk]) : chunk;
    let newline;
    while ((newline = carry.indexOf(0x0a)) !== -1) {
      const line = carry.subarray(0, newline);
      offset += newline + 1;
      carry = carry.subarray(newline + 1);
      yield { raw: line.toString("utf8"), offset, complete: true };
    }
  }
  // Trailing bytes with no newline are either a finished file that simply lacks
  // one or a line the writer is still emitting. They are offered so a complete
  // final turn is not missed, and marked so the caller only commits past them
  // once they have actually parsed.
  if (carry?.length) yield { raw: carry.toString("utf8"), offset: offset + carry.length, complete: false };
}

/** Only allowlisted tool names re-enter a cohort resumed from the index. */
function safeToolNames(value) {
  return Array.isArray(value) ? value.filter(isSafeToolName) : [];
}

/**
 * Stream a file and return only accounting records plus a count of malformed
 * rows. Pass `resume` to continue an earlier read: `offset` is the byte position
 * it stopped at, `cohortTools` and `currentTools` the two halves of the cohort
 * left open there, and `messageGroup` the salted fingerprint of the assistant
 * message `currentTools` was being accumulated for. `salt` is the index's own,
 * threaded in so this function can decide whether the first line it reads
 * continues that message without ever storing a raw id.
 *
 * A cohort is grouped by message id rather than by line. Claude Code streams
 * each `tool_use` content block as its own JSONL line, so a message that calls
 * two tools in parallel arrives as two lines sharing one `message.id`; taking
 * the last line's tools as the cohort attributed the whole following turn to
 * whichever block happened to be written last.
 *
 * Records read from a line that was not newline-terminated are returned as
 * `tailRecords`, separately from the committed `records`. The offset does not
 * advance past that line, so the next scan reads it again: a caller that stored
 * it alongside the committed records would count that turn twice.
 */
export async function readClaudeRecords(file, resume = null, salt = "") {
  const records = [];
  let committedRecords = 0;
  let parseErrors = 0;
  // The cohort of the most recently completed assistant message: what the next
  // message's billed records are attributed to.
  let cohortTools = safeToolNames(resume?.cohortTools);
  // The tools of the message currently being read, which becomes the cohort once
  // some later line proves that message is over.
  let currentTools = safeToolNames(resume?.currentTools);
  // The identity of that in-progress message. The raw id stays in memory for
  // within-scan comparisons and is never returned; only the fingerprint crosses
  // the persistence boundary, because the index is metadata-only.
  let currentMessageId = null;
  let currentGroup = typeof resume?.messageGroup === "string" ? resume.messageGroup : null;
  const fingerprintId = (value) => fingerprint(value, salt);
  /**
   * Open the message a line belongs to. A line whose id matches the one being
   * accumulated joins it; anything else — including a line whose id could not be
   * read at all — closes the previous message and starts a new one, so two
   * messages are never merged by accident.
   */
  const openMessage = (messageId) => {
    const continues = messageId !== null
      && (currentMessageId !== null ? messageId === currentMessageId : currentGroup !== null && fingerprintId(messageId) === currentGroup);
    if (continues) {
      currentMessageId = messageId;
      return;
    }
    cohortTools = currentTools;
    currentTools = [];
    currentMessageId = messageId;
    currentGroup = messageId === null ? null : fingerprintId(messageId);
  };
  const start = Number.isInteger(resume?.offset) && resume.offset > 0 ? resume.offset : 0;
  // Progress is only committed for lines that were fully read and understood, so
  // a resumed scan never skips past a line it did not actually account for.
  let offset = start;
  let committed = { cohortTools, currentTools, messageGroup: currentGroup };
  // A read that ends early must say so. Reporting it as complete would let the
  // caller cache a partial file as fully indexed until the file changes again.
  let truncated = false;
  try {
    for await (const line of linesFrom(file.path, start)) {
      const raw = line.raw.endsWith("\r") ? line.raw.slice(0, -1) : line.raw;
      if (!raw.trim()) {
        if (line.complete) { offset = line.offset; committed = { cohortTools, currentTools, messageGroup: currentGroup }; committedRecords = records.length; }
        continue;
      }
      const toolNames = toolNamesFromClaudeRawLine(raw);
      const record = recordFromClaudeRawLine(raw, file, toolNames);
      // An unterminated line that will not parse is far more likely to be a
      // half-written append than a corrupt record. Leave it uncommitted and
      // uncounted; the next scan reads it once the writer has finished.
      if (record?.parseError && !line.complete) break;
      if (record?.parseError) parseErrors++;
      else if (record) {
        // The record's own id was already read out of the redacted decode, so it
        // is preferred over lexing the line a second time.
        openMessage(isSafeMessageId(record.messageId) ? record.messageId : null);
        // A tool result is represented by a user-side event between assistant
        // records. Attribute the next billed assistant request to the safe tool
        // names called in the message immediately beforehand, not to transcript
        // content — and never to this line's own siblings, which is why the
        // cohort is read before this line's tools are added to it.
        if (cohortTools.length) record.priorTools = cohortTools;
        if (toolNames.length) currentTools = [...new Set([...currentTools, ...toolNames])];
        // The record carries its whole message's tools so far, not just this
        // line's. Deduplication keeps the last streamed row of a message, so a
        // per-line list dropped every `tool_use` block written before it: a
        // parallel call was counted as one call for one tool, and a tool that
        // only ever appeared on an earlier sibling line was never counted at all
        // while still being attributed follow-on cost.
        record.tools = currentTools;
        records.push(record);
      } else if (toolNames.length) {
        // Some tool-use events have no billing payload of their own. They still
        // describe the cohort whose following request we can measure, and they
        // are usually siblings of a line that does, so they are grouped the same
        // way — by the id lexed straight off the line.
        openMessage(messageIdFromClaudeRawLine(raw));
        currentTools = [...new Set([...currentTools, ...toolNames])];
      } else if (!isToolResultLine(raw)) {
        // A fresh human turn ends the cohort. Without this the tool called
        // before the prompt would be charged for every later turn in the
        // session, systematically inflating tool and MCP cost.
        cohortTools = [];
        currentTools = [];
        currentMessageId = null;
        currentGroup = null;
      }
      if (line.complete) { offset = line.offset; committed = { cohortTools, currentTools, messageGroup: currentGroup }; committedRecords = records.length; }
    }
  } catch {
    parseErrors++;
    truncated = true;
  }
  return {
    records: records.slice(0, committedRecords),
    tailRecords: records.slice(committedRecords),
    parseErrors,
    offset,
    cohortTools: committed.cohortTools,
    currentTools: committed.currentTools,
    messageGroup: committed.messageGroup,
    truncated,
  };
}
