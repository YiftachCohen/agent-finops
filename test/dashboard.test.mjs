import test from "node:test";
import assert from "node:assert/strict";
import { get } from "node:http";
import { isLoopbackHost, renderDashboard, startDashboard } from "../src/dashboard.mjs";

function request(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = get(url, { headers }, (response) => {
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
  topProjects: [{ id: "112233445566", usd: 12.34, requests: 4, usage: { total: 4321 } }],
};

// The page carries its data as one inert JSON island. `embeddedJson` escapes
// `<`, `>`, and `&` as JSON string escapes, which `JSON.parse` decodes back on
// its own — so reading the payload needs no unescaping of its own.
function payloadOf(page) {
  return JSON.parse(/const DATA = (.*);\n/.exec(page)[1]);
}

test("a hostile model, tool, session, project, or label cannot break out of the inert data script", () => {
  // Model and tool names come from a log file, and a label comes from a local
  // config file. The page embeds them all in a JSON island, so the only thing
  // standing between a provider- or file-controlled string and script execution
  // is `embeddedJson`.
  const hostile = `</script><img src=x onerror="alert(1)">&'"`;
  const usage = { input: 1, cacheCreate: 1, cacheRead: 1, output: 1, total: 4 };
  const page = renderDashboard({
    ...report,
    byModel: { [hostile]: { usd: 1, outputUsd: 0.5, requests: 1, usage } },
    topTools: [{ name: hostile, usd: 1, outputUsd: 0.5, calls: 1, followOnRequests: 1, usage }],
    topSessions: [{ id: hostile, project: hostile, usd: 1, outputUsd: 0.5, requests: 1, usage }],
    topProjects: [{ id: hostile, usd: 1, outputUsd: 0.5, requests: 1, usage }],
  }, { recommendations: [{ severity: "high", kind: hostile, evidence: hostile, action: hostile }] }, { [hostile]: hostile });

  assert.ok(!page.includes(hostile), "the raw sequence never reaches the page");
  assert.ok(!page.includes("</script><img"), "no injected tag closes the data script");
  assert.equal(page.split("</script>").length - 1, 1, "the page still has exactly one script end");
  // The escaped forms are what should appear instead.
  assert.match(page, /\\u003c\/script\\u003e/);
  assert.match(page, /\\u0026/);
});

test("projects reach the page with their local labels, and every row carries its dollar split", () => {
  const usage = { input: 10, cacheCreate: 20, cacheRead: 30, output: 40, total: 100 };
  const usdByClass = { input: 1, cacheWrite: 2, cacheWrite1h: 1.5, cacheWrite5m: 0.5, cacheRead: 3, output: 4 };
  const page = renderDashboard({
    ...report,
    total: { ...report.total, usd: 10, outputUsd: 4, usdByClass, usage },
    insights: { ...report.insights, perTurnUsd: { mean: 2.5, p50: 2, p90: 4 } },
    byDay: { "2026-08-01": { usd: 10, outputUsd: 4, usdByClass, usage } },
    byModel: { "claude-sonnet-4-6": { usd: 10, outputUsd: 4, usdByClass, usage, requests: 4 } },
    topSessions: [{ id: "aabbccddeeff", project: "112233445566", usd: 10, outputUsd: 4, usdByClass, usage, requests: 4, avgPromptTokens: 15 }],
    topProjects: [
      { id: "112233445566", usd: 8, outputUsd: 4, usdByClass, usage, requests: 3 },
      { id: "667788990011", usd: 2, outputUsd: 1, usdByClass, usage, requests: 1 },
    ],
  }, { recommendations: [] }, { "112233445566": "Payments API" });
  const data = payloadOf(page);

  assert.deepEqual(data.projects.map((project) => [project.id, project.label]), [["112233445566", "Payments API"], ["667788990011", null]]);
  assert.equal(data.projects[0].requests, 3);
  // A session names the project it ran under, and the label for it when there
  // is one. The label is a local name; the fingerprint is what the CLI takes.
  assert.equal(data.sessions[0].project, "112233445566");
  assert.equal(data.sessions[0].label, "Payments API");
  assert.equal(data.sessions[0].avgPromptTokens, 15);

  // Bar geometry is dollars, so every row that can be drawn carries the four
  // charged classes. The per-TTL rows break one of them down and would
  // double-count as a fifth segment, so they stay off the page.
  const charged = ["cacheRead", "cacheWrite", "input", "output"];
  for (const row of [data.total, data.byDay[0], data.models[0], data.sessions[0], ...data.projects]) {
    assert.deepEqual(Object.keys(row.usdByClass).sort(), charged);
    assert.ok(Math.abs(charged.reduce((sum, key) => sum + row.usdByClass[key], 0) - 10) < 1e-9);
  }
  assert.deepEqual(data.insights.perTurnUsd, { mean: 2.5, p50: 2, p90: 4 });

  // The label names the project row; the session row keeps its own id.
  assert.match(page, /data-mode="projects"/);
  assert.match(page, /cost by class/);
  assert.ok(page.includes("Payments API"));
});

test("a report from before this release still renders, with no label and no distribution", () => {
  // Tag-shaped and older-index data has no `usdByClass`, no `topProjects`, and
  // no `perTurnUsd`. The page must fall back rather than fault.
  const data = payloadOf(renderDashboard({ ...report, topProjects: undefined }, { recommendations: [] }));
  assert.deepEqual(data.projects, []);
  assert.deepEqual(data.total.usdByClass, { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 });
  assert.equal(data.sessions[0].project, null);
  assert.equal(data.sessions[0].label, null);
  assert.equal(data.sessions[0].avgPromptTokens, 0);
  assert.equal(data.insights.perTurnUsd, undefined);
  // A tool row from before usdPerCall/soloShare existed falls back to null
  // rather than a divide-by-zero or an undefined leaking into the page.
  assert.equal(data.tools[0].usdPerCall, null);
  assert.equal(data.tools[0].soloShare, null);
});

test("tool rows carry per-call cost and solo share, and the row detail names both in the same lowercase voice", () => {
  const usage = { input: 100, cacheCreate: 0, cacheRead: 0, output: 100, total: 200 };
  const page = renderDashboard({
    ...report,
    topTools: [
      { name: "Bash", usd: 9, calls: 2, followOnRequests: 1, usdPerCall: 4.5, soloShare: 0.5, usage },
      { name: "mcp__issues__search", usd: 0.002, calls: 1, followOnRequests: 1, usdPerCall: 0.002, soloShare: null, usage },
    ],
  }, { recommendations: [] });
  const data = payloadOf(page);

  assert.equal(data.tools[0].usdPerCall, 4.5);
  assert.equal(data.tools[0].soloShare, 0.5);
  assert.equal(data.tools[1].usdPerCall, 0.002);
  assert.equal(data.tools[1].soloShare, null);

  // The client-side detail line is composed from these two fields; the
  // formatting helpers and the "of attributed cost" phrasing travel as source
  // in the inert script, in the same lowercase voice as the rest of the page.
  assert.match(page, /perCallMoney/);
  assert.match(page, /% of attributed cost/);
  assert.match(page, /solo n\/a/);
});

test("loopback Host header rule accepts only this port on a loopback name", () => {
  const port = 7474;
  const cases = [
    [undefined, false, "a request with no Host header"],
    ["127.0.0.1:7474", true, "the address the CLI prints"],
    ["localhost:7474", true, "the name a browser usually sends"],
    ["[::1]:7474", true, "IPv6 loopback"],
    ["127.0.0.1", true, "a bare loopback host with the default port elided"],
    ["localhost:7475", false, "a loopback name on another port"],
    ["127.0.0.1.attacker.example:7474", false, "a public name that only looks loopback"],
    ["attacker.example:7474", false, "a rebinding host"],
    ["127.0.0.1.attacker.example", false, "a public name with no port"],
    ["[::1]:7475", false, "IPv6 loopback on another port"],
  ];
  for (const [host, expected, why] of cases) assert.equal(isLoopbackHost(host, port), expected, `${why}: ${host}`);
});

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

test("dashboard favicon is inline and the page still loads no remote asset", async () => {
  const running = await startDashboard(report, { recommendations: [] }, { port: 0 });
  try {
    const root = await request(running.url);
    const policy = root.headers["content-security-policy"];
    // The mark travels in the page itself: no second route, no file read.
    assert.match(root.body, /<link rel="icon" href="data:image\/svg\+xml,/);
    assert.match(policy, /img-src data:;/);
    // data: is the only image source, so the favicon cannot become a beacon.
    assert.ok(!/img-src[^;]*(https?:|'self'|\*)/.test(policy));
    assert.equal((await request(`${running.url}favicon.svg`)).status, 404);
  } finally {
    await new Promise((resolve) => running.server.close(resolve));
  }
});

test("dashboard refuses a forged Host header so a public site cannot rebind to it", async () => {
  const running = await startDashboard(report, { recommendations: [] }, { port: 0 });
  try {
    const { port } = new URL(running.url);
    const rebound = await request(running.url, { Host: `attacker.example:${port}` });
    assert.equal(rebound.status, 403);
    assert.ok(!rebound.body.includes("Agent FinOps"));
    assert.equal((await request(running.url, { Host: `localhost:${port}` })).status, 200);
  } finally {
    await new Promise((resolve) => running.server.close(resolve));
  }
});
