// Friendly labels are opt-in local configuration. The file stores only the
// anonymous project id and a label the user chose; it never stores a path.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function defaultLabelsPath() {
  return process.env.AGENT_FINOPS_LABELS || join(homedir(), ".config", "agent-finops", "project-labels.json");
}

export function loadLabels(path = defaultLabelsPath()) {
  if (!existsSync(path)) return {};
  try {
    const labels = JSON.parse(readFileSync(path, "utf8"));
    return labels && typeof labels === "object" && !Array.isArray(labels) ? labels : {};
  } catch {
    return {};
  }
}

export function saveLabel(id, label, path = defaultLabelsPath()) {
  if (!/^[a-f0-9]{12}$/i.test(id)) throw new Error("Project id must be the 12-character id shown by `agent-finops projects`.");
  const trimmed = String(label || "").trim();
  if (!trimmed || trimmed.length > 80 || /[\r\n]/.test(trimmed)) throw new Error("Label must be 1-80 characters on one line.");
  const labels = loadLabels(path);
  labels[id] = trimmed;
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp`;
  writeFileSync(temp, JSON.stringify(labels, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(temp, path);
  chmodSync(path, 0o600);
  return labels;
}

export function displayProject(id, labels = {}) {
  return labels[id] ? `${labels[id]} (${id})` : id;
}
