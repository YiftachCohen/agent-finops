// Metadata-only JSONL ingestion. The log line must enter this process as text,
// but content-bearing property values are replaced before JSON.parse can decode
// them into JavaScript strings or objects.

import { createHash } from "node:crypto";

const ASSISTANT_ROLE_RE = /"role"\s*:\s*"assistant"/;
const TOOL_RESULT_RE = /"type"\s*:\s*"tool_result"|"toolUseResult"\s*:/;
const SAFE_TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,159}$/;
// The model id is the only free-form string that crosses from log text into the
// index, tags, the terminal, and shared JSON. Allowlist the shape every real id
// has — vendor prefix, dots, dashes, a Bedrock `:0` suffix, a `[1m]` marker —
// so control characters, escape sequences, and unbounded strings never persist.
const SAFE_MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,127}$/;
// A message id, as `msg_01AbC...`. It is never rendered and never persisted in
// the clear — it groups the streamed lines of one assistant message, and only a
// salted fingerprint of it crosses into the index — but it is still read out of
// a log line by a lexer that does not decode escapes, so the shape is bounded
// here. Anything carrying a quote, a brace, or a backslash is refused outright.
const SAFE_MESSAGE_ID_RE = /^[A-Za-z0-9][\w.:-]{0,127}$/;

/**
 * The allowlists above, exported as predicates. The index re-checks a stored
 * record against them when it loads history whose log file no longer exists: that
 * record can never be re-derived, so its load is the last place its shape can be
 * validated.
 */
export function isSafeToolName(value) {
  return typeof value === "string" && SAFE_TOOL_NAME_RE.test(value);
}

export function isSafeModelId(value) {
  return typeof value === "string" && SAFE_MODEL_ID_RE.test(value);
}

export function isSafeMessageId(value) {
  return typeof value === "string" && SAFE_MESSAGE_ID_RE.test(value);
}

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
  // Tool-result envelopes carry captured terminal output, file bodies, and
  // edit payloads. These records are rejected before decoding, but a line whose
  // captured output happens to contain an assistant role marker reaches the
  // decoder, so every content-bearing key in the envelope is redacted too.
  // `toolUseResult` covers the subtree; the rest are listed because the same
  // names also appear on their own elsewhere in the schema.
  "stdout",
  "stderr",
  "toolUseResult",
  "file",
  "originalFile",
  "filePath",
  "file_path",
  "oldString",
  "newString",
  "old_string",
  "new_string",
  "structuredPatch",
  "patch",
  "prompt",
  "lastPrompt",
  "query",
  "description",
  "results",
  "matches",
  "attachment",
  "error",
]);

// The two-character JSON string escapes. `\u` is handled separately.
const SHORT_ESCAPES = { __proto__: null, '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

/**
 * Decode the escapes in a lexed key so the denylist sees the property name a
 * decoder would produce rather than its source spelling: `"content"` and
 * `"content"` are the same property, and only one of them was being matched.
 *
 * Deliberately hand-written rather than `JSON.parse`: this runs before any
 * decoding, and it is applied only to key source text, never to a value.
 * Malformed input returns null, which the caller treats as sensitive —
 * over-redaction is the safe direction.
 */
function decodeJsonKey(source) {
  if (!source.includes("\\")) return source;
  let out = "";
  let i = 0;
  while (i < source.length) {
    if (source[i] !== "\\") {
      out += source[i];
      i++;
      continue;
    }
    const escape = source[i + 1];
    if (escape === "u") {
      const hex = source.slice(i + 2, i + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
      out += String.fromCharCode(Number.parseInt(hex, 16));
      i += 6;
      continue;
    }
    if (!(escape in SHORT_ESCAPES)) return null;
    out += SHORT_ESCAPES[escape];
    i += 2;
  }
  return out;
}

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

/**
 * Return the opening brace of every object holding `"type": "tool_use"`, in one
 * forward pass. Rescanning from the start for each match made a large assistant
 * line quadratic in its own length.
 */
function toolUseObjectStarts(text) {
  const starts = [];
  const stack = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "{") {
      stack.push(i);
      i++;
      continue;
    }
    if (c === "}") {
      stack.pop();
      i++;
      continue;
    }
    if (c !== '"') {
      i++;
      continue;
    }
    const keyEnd = stringEnd(text, i);
    if (stack.length && text.slice(i + 1, keyEnd - 1) === "type") {
      const colon = skipWhitespace(text, keyEnd);
      if (text[colon] === ":") {
        const start = skipWhitespace(text, colon + 1);
        if (text[start] === '"' && text.slice(start + 1, stringEnd(text, start) - 1) === "tool_use") starts.push(stack.at(-1));
      }
    }
    i = keyEnd;
  }
  return starts;
}

/**
 * True when a line is a tool-result envelope rather than a fresh human turn.
 * Follow-on attribution stays open across these and closes on anything else.
 */
export function isToolResultLine(raw) {
  return TOOL_RESULT_RE.test(raw);
}

/**
 * Walk the direct properties of one JSON object, yielding each key's source text
 * and the offset its value starts at, using only lexical scans. The value is
 * measured lazily, after the consumer has looked at the key, so a consumer that
 * stops on the first match never pays to scan the rest of a large subtree.
 */
function* objectProperties(text, objectStart) {
  let i = objectStart + 1;
  while (i < text.length) {
    i = skipWhitespace(text, i);
    if (text[i] === "}") return;
    if (text[i] === ",") {
      i++;
      continue;
    }
    if (text[i] !== '"') return;
    const keyEnd = stringEnd(text, i);
    const key = text.slice(i + 1, keyEnd - 1);
    const colon = skipWhitespace(text, keyEnd);
    if (text[colon] !== ":") return;
    const start = skipWhitespace(text, colon + 1);
    yield { key, start };
    i = valueEnd(text, start);
  }
}

/** Read a direct string property from one JSON object using only lexical scans. */
function objectStringProperty(text, objectStart, wantedKey) {
  for (const { key, start } of objectProperties(text, objectStart)) {
    if (key === wantedKey && text[start] === '"') return text.slice(start + 1, stringEnd(text, start) - 1);
  }
  return null;
}

/** The offset of the opening brace of a direct object-valued property, or -1. */
function objectObjectProperty(text, objectStart, wantedKey) {
  for (const { key, start } of objectProperties(text, objectStart)) {
    if (key === wantedKey && text[start] === "{") return start;
  }
  return -1;
}

/**
 * Read a direct string property of the line's own top-level object, or null.
 * A regex would match the first occurrence anywhere in the line: Claude Code
 * writes `message` before the envelope's `type`, so the nested type of a content
 * block or of captured tool output answered for the record's own type.
 */
function topLevelStringProperty(raw, wantedKey) {
  const objectStart = skipWhitespace(raw, 0);
  if (raw[objectStart] !== "{") return null;
  return objectStringProperty(raw, objectStart, wantedKey);
}

/**
 * True when a line's envelope claims to be a billed assistant turn. The two
 * observed shapes are a top-level `type: assistant` and a `type: message` whose
 * `message.role` is checked after the redacted decode. The role substring is
 * only a fallback for a line with no top-level `type` at all, so captured tool
 * output can no longer speak for the envelope that contains it.
 */
function isAssistantEnvelope(raw) {
  const type = topLevelStringProperty(raw, "type");
  if (type === null) return ASSISTANT_ROLE_RE.test(raw);
  return type === "assistant" || type === "message";
}

/**
 * Extract only safe tool names from assistant tool-use blocks. Tool arguments,
 * results, and every other content value remain lexically opaque.
 */
export function toolNamesFromClaudeRawLine(raw) {
  if (!isAssistantEnvelope(raw)) return [];
  const names = new Set();
  for (const objectStart of toolUseObjectStarts(raw)) {
    const name = objectStringProperty(raw, objectStart, "name");
    if (isSafeToolName(name)) names.add(name);
  }
  return [...names];
}

/**
 * Read `message.id` off an assistant line, or null. Claude Code streams one
 * assistant message as several JSONL lines that share this id, so it is what
 * says whether a line opens a new cohort or joins the one already being read.
 *
 * The same lexer as `toolNamesFromClaudeRawLine`, for the same reason: this runs
 * on every line, including the tool-use lines that carry no billing payload and
 * therefore never reach the redacted decoder at all. The result is only ever
 * compared — in memory against another raw id, and across a scan boundary as a
 * salted fingerprint — and an id outside `SAFE_MESSAGE_ID_RE` is reported as
 * absent, which the caller treats as a new message rather than a match.
 */
export function messageIdFromClaudeRawLine(raw) {
  if (!isAssistantEnvelope(raw)) return null;
  const objectStart = skipWhitespace(raw, 0);
  if (raw[objectStart] !== "{") return null;
  const messageStart = objectObjectProperty(raw, objectStart, "message");
  if (messageStart === -1) return null;
  const id = objectStringProperty(raw, messageStart, "id");
  return isSafeMessageId(id) ? id : null;
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
    const colon = skipWhitespace(raw, keyEnd);
    if (raw[colon] !== ":") {
      i = keyEnd;
      continue;
    }
    // A null decode means the key source is malformed; redact it rather than
    // guess what a decoder would make of it.
    const key = decodeJsonKey(raw.slice(i + 1, keyEnd - 1));
    if (key !== null && !SENSITIVE_KEYS.has(key)) {
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

/**
 * A one-way local id. The salt is threaded in explicitly rather than read from
 * anywhere: it lives in the 0600 index, and this function stays pure so a test
 * can prove that the same pre-image under two salts yields two different ids.
 *
 * Salting matters because the pre-images are low-entropy and highly structured —
 * an absolute log path, a project directory name. Against an unsalted 12-hex
 * prefix, guessing a plausible username or repository and hashing it is a cheap
 * confirm-or-deny on any report someone shares. The separator keeps the salt
 * from running into the value.
 */
export function fingerprint(value, salt = "") {
  return createHash("sha256").update(`${salt} ${value}`).digest("hex").slice(0, 12);
}

function nonNegativeInt(value) {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Return only the metadata required for accounting, or null. `tools` may be
 * supplied by a caller that already scanned the line, to avoid a second pass.
 */
export function recordFromClaudeRawLine(raw, source, tools = null) {
  // Reject everything that is not an assistant envelope before JSON decoding; a
  // false positive merely reaches the redacted decoder and is discarded by the
  // semantic check below, which this gate deliberately mirrors.
  if (!isAssistantEnvelope(raw)) return null;

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
  // Both fields are validated here rather than at every reader: an unparseable
  // timestamp would silently bucket a turn under `<unknown-date>` anyway, and a
  // model id is rendered verbatim in the terminal and in shared JSON.
  const timestamp = typeof parsed.timestamp === "string" && Number.isFinite(Date.parse(parsed.timestamp)) ? parsed.timestamp : null;
  const model = isSafeModelId(message.model) ? message.model : "<unknown>";
  // `cache_creation` breaks the cache-write total down by TTL. The two classes
  // are billed at different multiples of the input rate, so the split is kept
  // rather than collapsed. It is a breakdown of `cacheCreate`, never an addition
  // to it.
  const cacheCreation = usage.cache_creation && typeof usage.cache_creation === "object" ? usage.cache_creation : null;
  const normalizedUsage = {
    input: nonNegativeInt(usage.input_tokens),
    cacheCreate: nonNegativeInt(usage.cache_creation_input_tokens),
    cacheCreate1h: nonNegativeInt(cacheCreation?.ephemeral_1h_input_tokens),
    cacheCreate5m: nonNegativeInt(cacheCreation?.ephemeral_5m_input_tokens),
    cacheRead: nonNegativeInt(usage.cache_read_input_tokens),
    output: nonNegativeInt(usage.output_tokens),
  };
  // Synthetic assistant events sometimes carry an empty usage object. They are
  // not a billed request and would make a report look busier than it is.
  if (!Object.values(normalizedUsage).some(Boolean)) return null;
  // A discovered file arrives with its ids already salted by `findClaudeJsonl`.
  // The string form is a test convenience and is deliberately unsalted: nothing
  // that reaches the index takes this branch.
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
    tools: tools ?? toolNamesFromClaudeRawLine(raw),
    usage: normalizedUsage,
  };
}
