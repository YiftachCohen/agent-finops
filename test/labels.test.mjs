import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { displayProject, loadLabels, saveLabel } from "../src/labels.mjs";

test("a label is refused unless it is one short line against a real project id", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-finops-labels-reject-"));
  const path = join(root, "labels.json");
  try {
    // The id addresses a stored record and the label is echoed into terminal
    // output, so neither is accepted as free-form text.
    for (const id of ["", "not-a-fingerprint", "d78a771feca", "d78a771feca2f", "../../etc/passwd", "__proto__"]) {
      assert.throws(() => saveLabel(id, "Billing app", path), /Project id must be/, JSON.stringify(id));
    }
    for (const label of ["", "   ", "a".repeat(81), "two\nlines", "carriage\rreturn"]) {
      assert.throws(() => saveLabel("d78a771feca2", label, path), /Label must be 1-80 characters/, JSON.stringify(label));
    }
    assert.equal(existsSync(path), false, "a rejected label writes nothing");
    assert.deepEqual(loadLabels(path), {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("labels persist a user-provided name without a path", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-finops-labels-"));
  const path = join(root, "labels.json");
  try {
    saveLabel("d78a771feca2", "Billing app", path);
    assert.deepEqual(loadLabels(path), { d78a771feca2: "Billing app" });
    assert.equal(displayProject("d78a771feca2", loadLabels(path)), "Billing app (d78a771feca2)");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.ok(!readFileSync(path, "utf8").includes("/Users/"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
