import test from "node:test";
import assert from "node:assert/strict";
import { get } from "node:http";
import { startDashboard } from "../src/dashboard.mjs";

function request(url) {
  return new Promise((resolve, reject) => {
    const req = get(url, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    req.on("error", reject);
  });
}

const report = {
  generatedAt: "2026-08-02T10:00:00Z",
  scope: { recordsAfterDateFilter: 4 },
  total: { usd: 12.34, requests: 4, usage: { total: 4321 } },
  insights: { cacheReadShare: 0.8, outputCostShare: 0.2 },
  byDay: { "2026-08-01": { usd: 3, usage: { total: 100 } }, "2026-08-02": { usd: 9.34, usage: { total: 4221 } } },
  byModel: { "claude-sonnet-4-6": { usd: 12.34, requests: 4, usage: { total: 4321 } } },
  topTools: [{ name: "mcp__internal__search", usd: 4, calls: 2, followOnRequests: 2, usage: { total: 1000 } }],
  topSessions: [{ id: "aabbccddeeff", usd: 8, requests: 2, usage: { total: 2000 } }],
};

test("dashboard serves aggregate metadata on a random loopback port and no other route", async () => {
  const running = await startDashboard(report, { recommendations: [{ severity: "medium", kind: "output-cost", evidence: "Output is high.", action: "Constrain it." }] }, { port: 0 });
  try {
    const root = await request(running.url);
    assert.equal(new URL(running.url).hostname, "127.0.0.1");
    assert.equal(root.status, 200);
    assert.match(root.headers["content-security-policy"], /connect-src 'none'/);
    assert.match(root.body, /Agent FinOps/);
    assert.match(root.body, /mcp__internal__search/);
    assert.ok(!root.body.includes("TOP-SECRET-EXAMPLE"));
    const missing = await request(`${running.url}missing`);
    assert.equal(missing.status, 404);
  } finally {
    await new Promise((resolve) => running.server.close(resolve));
  }
});
