import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { displayProject, loadLabels, saveLabel } from "../src/labels.mjs";

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
