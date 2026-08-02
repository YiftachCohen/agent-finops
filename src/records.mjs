// Metadata-only JSONL ingestion. The log line must enter this process as text,
// but content-bearing property values are replaced before JSON.parse can decode
// them into JavaScript strings or objects.

import { createHash } from "node:crypto";

const TOP_TYPE_RE = /"type"\s*:\s*"([A-Za-z0-9_.-]+)"/;
const ASSISTANT_ROLE_RE = /"role"\s*:\s*"assistant"/;
const TOOL_USE_RE = /"type"\s*:\s*"tool_use"/g;
const SAFE_TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,159}$/;
const SENSITIVE_KEYS = new Set([
  "content",
  "text",
  "thinking",
  "input",
  "arguments",
  "instructions",
  "cwd",
  "summary",
  "command",
  "output",
  "reasoning_content",
]);

function skipWhitespace(text, start) {
  let i = start;
  while (/\s/.test(text[i] || "")) i++;
  return i;
}

function stringEnd(text, start) {
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === "\\") i += 2;
    else if (text[i++] === '"') return i;
  }
  return text.length;
}

function valueEnd(text, start) {
  const first = text[start];
  if (first === '"') return stringEnd(text, start);
  if (first !== "{" && first !== "[") {
    let i = start;
    while (i < text.length && !",}]".includes(text[i])) i++;
    return i;
  }

  const stack = [first === "{" ? "}" : "]"];
  let i = start + 1;
  while (i < text.length && stack.length) {
    const c = text[i];
    if (c === '"') {
      i = stringEnd(text, i);
      continue;
    }
    if (c === "{") stack.push("}");
    else if (c === "[") stack.push("]");
    else if (c === stack.at(-1)) stack.pop();
    i++;
  }
  return i;
}

/** Return the opening brace of the object enclosing an offset, without decoding values. */
function enclosingObjectStart(text, offset) {
  const stack = [];
  let i = 0;
  while (i < offset) {
    if (text[i] === '"') {
      i = stringEnd(text, i);
      continue;
    }
    if (text[i] === "{") stack.push(i);
    else if (text[i] === "}") stack.pop();
    i++;
  }
  return stack.at(-1) ?? null;
}

/** Read a direct string property from one JSON object using only lexical scans. */
function objectStringProperty(text, objectStart, wantedKey) {
  let i = objectStart + 1;
  while (i < text.length) {
    i = skipWhitespace(text, i);
    if (text[i] === "}") return null;
    if (text[i] === ",") {
      i++;
      continue;
    }
    if (text[i] !== '"') return null;
    const keyEnd = stringEnd(text, i);
    const key = text.slice(i + 1, keyEnd - 1);
    const colon = skipWhitespace(text, keyEnd);
    if (text[colon] !== ":") return null;
    const start = skipWhitespace(text, colon + 1);
    const end = valueEnd(text, start);
    if (key === wantedKey && text[start] === '"') return text.slice(start + 1, stringEnd(text, start) - 1);
    i = end;
  }
  return null;
}

/**
 * Extract only safe tool names from assistant tool-use blocks. Tool arguments,
 * results, and every other content value remain lexically opaque.
 */
export function toolNamesFromClaudeRawLine(raw) {
  const type = TOP_TYPE_RE.exec(raw)?.[1];
  if (type !== "assistant" && !ASSISTANT_ROLE_RE.test(raw)) return [];
  const names = new Set();
  TOOL_USE_RE.lastIndex = 0;
  let match;
  while ((match = TOOL_USE_RE.exec(raw))) {
    const objectStart = enclosingObjectStart(raw, match.index);
    if (objectStart == null) continue;
    const name = objectStringProperty(raw, objectStart, "name");
    if (name && SAFE_TOOL_NAME_RE.test(name)) names.add(name);
  }
  return [...names];
}

/**
 * Replace the value of known content-bearing JSON properties with `null`.
 * This is a lexer, not a parser: it preserves all structural JSON and does not
 * decode the original property values. Unknown malformed lines stay malformed
 * and are handled by the caller.
 */
export function redactSensitiveProperties(raw) {
  let out = "";
  let cursor = 0;
  let i = 0;
  while (i < raw.length) {
    if (raw[i] !== '"') {
      i++;
      continue;
    }
    const keyEnd = stringEnd(raw, i);
    const key = raw.slice(i + 1, keyEnd - 1);
    const colon = skipWhitespace(raw, keyEnd);
    if (!SENSITIVE_KEYS.has(key) || raw[colon] !== ":") {
      i = keyEnd;
      continue;
    }
    const start = skipWhitespace(raw, colon + 1);
    const end = valueEnd(raw, start);
    out += raw.slice(cursor, start) + "null";
    cursor = end;
    i = end;
  }
  return out ? out + raw.slice(cursor) : raw;
}

export function fingerprint(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function nonNegativeInt(value) {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Return only the metadata required for accounting, or null. */
export function recordFromClaudeRawLine(raw, source) {
  const type = TOP_TYPE_RE.exec(raw)?.[1];
  // Claude Code has two observed envelopes: direct `type: assistant` records and
  // `type: message` records with `message.role: assistant`. Reject everything
  // else before JSON decoding; a false positive merely reaches the redacted
  // decoder and is discarded by the semantic check below.
  if (type !== "assistant" && !ASSISTANT_ROLE_RE.test(raw)) return null;

  let parsed;
  try {
    parsed = JSON.parse(redactSensitiveProperties(raw));
  } catch {
    return { parseError: true };
  }
  const message = parsed.message;
  const assistant = parsed.type === "assistant" || (parsed.type === "message" && message?.role === "assistant");
  if (!assistant) return null;
  const usage = message?.usage;
  if (!usage || typeof usage !== "object") return null;
  const timestamp = typeof parsed.timestamp === "string" ? parsed.timestamp : null;
  const model = typeof message.model === "string" ? message.model : "<unknown>";
  const normalizedUsage = {
    input: nonNegativeInt(usage.input_tokens),
    cacheCreate: nonNegativeInt(usage.cache_creation_input_tokens),
    cacheRead: nonNegativeInt(usage.cache_read_input_tokens),
    output: nonNegativeInt(usage.output_tokens),
  };
  // Synthetic assistant events sometimes carry an empty usage object. They are
  // not a billed request and would make a report look busier than it is.
  if (!Object.values(normalizedUsage).some(Boolean)) return null;
  const sourceMeta = typeof source === "string"
    ? { source: fingerprint(source), project: fingerprint(source) }
    : source;
  return {
    provider: "claude",
    source: sourceMeta.source,
    project: sourceMeta.project,
    messageId: typeof message.id === "string" ? message.id : null,
    requestId: typeof parsed.requestId === "string" ? parsed.requestId : null,
    model,
    timestamp,
    tools: toolNamesFromClaudeRawLine(raw),
    usage: normalizedUsage,
  };
}
