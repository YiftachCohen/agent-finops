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

test("the readings row carries the run rate and what the ranked findings add up to", () => {
  const runRate = { days: 30, firstDay: "2026-07-04", lastDay: "2026-08-02", usdPerDay: 170.6, projectedMonthlyUsd: 5118, peakDay: { day: "2026-07-28", usd: 351.83, ratioToMedian: 2.3 } };
  const page = renderDashboard({ ...report, insights: { ...report.insights, runRate } }, {
    totalEstimatedSavingsUsd: 1977.3,
    recommendations: [
      { severity: "high", kind: "model-concentration", evidence: "Opus is most of it.", action: "Try a tagged run.", estimatedSavingsUsd: 1968.3 },
      { severity: "info", kind: "cache-ttl", evidence: "Most writes are 1-hour.", action: "Measure both cadences.", estimatedSavingsUsd: 9 },
      { severity: "medium", kind: "output-cost", evidence: "Output is high.", action: "Constrain it." },
    ],
  });
  const data = payloadOf(page);

  assert.deepEqual(data.insights.runRate, runRate);
  // The total the analysis already ranks by, with the count of rows it came
  // from: an upper bound across findings, never a total of the window.
  assert.equal(data.savings.totalUsd, 1977.3);
  assert.equal(data.savings.quantifiedFindings, 2, "the unquantified finding is not counted as a zero");

  // The two readings a spend figure is unreadable without replace the two token
  // shares the cost-by-class legend and bars already say better.
  assert.match(page, /<p class="micro">run rate<\/p>/);
  assert.match(page, /<p class="micro">identified savings<\/p>/);
  assert.match(page, /per active day \/ ~/);
  assert.match(page, /upper bound across/);
  assert.ok(!page.includes("cache-read share"), "the token-share reading is gone");
  assert.ok(!page.includes("output-cost share"), "the output-share reading is gone");
  // The two readings that were already the right ones stay exactly as they were.
  assert.match(page, /<p class="micro">token volume<\/p>/);
  assert.match(page, /<p class="micro">cost per turn<\/p>/);
});

test("a window with no rate and nothing quantified reads as a dash, not as a zero", () => {
  // Tag-shaped and older-index data carries no run rate at all, and an analysis
  // where no rule could defend a counterfactual carries no total.
  const data = payloadOf(renderDashboard(report, { recommendations: [{ severity: "medium", kind: "output-cost", evidence: "Output is high.", action: "Constrain it." }] }));
  assert.equal(data.insights.runRate, undefined);
  assert.equal(data.savings.totalUsd, 0);
  assert.equal(data.savings.quantifiedFindings, 0);

  // An analysis from before `totalEstimatedSavingsUsd` existed is summed from
  // the rows rather than left blank.
  const legacy = payloadOf(renderDashboard(report, {
    recommendations: [
      { severity: "high", kind: "model-concentration", evidence: "e", action: "a", estimatedSavingsUsd: 12 },
      { severity: "info", kind: "cache-ttl", evidence: "e", action: "a", estimatedSavingsUsd: 3 },
    ],
  }));
  assert.equal(legacy.savings.totalUsd, 15);
  assert.equal(legacy.savings.quantifiedFindings, 2);

  // Both readings fall back to a dash and a neutral note rather than inventing
  // a rate or claiming there is nothing to save.
  const page = renderDashboard(report, { recommendations: [] });
  assert.match(page, /runRate \? money\(runRate\.usdPerDay\) : '—'/);
  assert.match(page, /'no dated records in this window'/);
  assert.match(page, /'nothing quantified in this window'/);
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
  // $/call and $/turn share one helper, so the two cannot drift apart.
  assert.match(page, /fineMoney/);
  assert.match(page, /% of attributed cost/);
  assert.match(page, /solo n\/a/);
});

test("recommendations reach the page ranked, each carrying its estimated saving", () => {
  const page = renderDashboard(report, {
    totalEstimatedSavingsUsd: 1977.3,
    recommendations: [
      { severity: "high", kind: "model-concentration", evidence: "Opus is most of it.", action: "Try a tagged run.", estimatedSavingsUsd: 1968.3 },
      { severity: "info", kind: "cache-ttl", evidence: "Most writes are 1-hour.", action: "Measure both cadences.", estimatedSavingsUsd: 9 },
      { severity: "medium", kind: "output-cost", evidence: "Output is high.", action: "Constrain it." },
    ],
  });
  const data = payloadOf(page);

  // The order the analysis produced is the order the page renders; the dashboard
  // does not re-sort, so the two surfaces cannot disagree on what to do first.
  assert.deepEqual(data.recommendations.map((rec) => [rec.kind, rec.estimatedSavingsUsd]), [
    ["model-concentration", 1968.3],
    ["cache-ttl", 9],
    // An analysis built before this field existed, or a rule with no defensible
    // counterfactual, falls back to null rather than a zero it cannot support.
    ["output-cost", null],
  ]);
  // The figure is rendered above the severity word in the same column, and the
  // heading says what the list is ordered by.
  assert.match(page, /note-savings/);
  assert.match(page, /rec\.estimatedSavingsUsd != null/);
  assert.match(page, /ranked by estimated savings/);
});

// A trend as `analyzeTrend` returns one, reduced to the fields the page reads.
// The nested reports are deliberately present here and deliberately absent from
// the payload: the browser gets deltas, not a second copy of every bucket.
function trendFixture(overrides = {}) {
  return {
    days: 7,
    current: { start: "2026-07-26", end: "2026-08-01", report: { total: { usd: 1690 } } },
    previous: { start: "2026-07-19", end: "2026-07-25", report: { total: { usd: 1204 } } },
    deltaUsd: 486,
    deltaPct: 0.4036544850498339,
    drivers: { byModel: [], byProject: [] },
    ...overrides,
  };
}

test("the what-changed section carries the two windows and the rows that moved, top three a side", () => {
  const trend = trendFixture({
    drivers: {
      byModel: [
        { model: "claude-opus-4-5", deltaUsd: 512.4 },
        { model: "claude-sonnet-4-6", deltaUsd: -33.6 },
        { model: "claude-haiku-4-5", deltaUsd: 7.2 },
        { model: "claude-opus-5", deltaUsd: 1.1 },
      ],
      byProject: [
        { id: "112233445566", deltaUsd: 480 },
        { id: "667788990011", deltaUsd: -20 },
        { id: "<unknown-project>", deltaUsd: 12 },
        { id: "aabbccddeeff", deltaUsd: 3 },
      ],
    },
  });
  const page = renderDashboard(report, { recommendations: [] }, { 112233445566: "Payments API" }, trend);
  const data = payloadOf(page);

  assert.equal(data.changed.days, 7);
  assert.deepEqual(data.changed.current, { start: "2026-07-26", end: "2026-08-01" });
  assert.deepEqual(data.changed.previous, { start: "2026-07-19", end: "2026-07-25" });
  // Three a side: past that the deltas are rounding against the headline.
  assert.deepEqual(data.changed.byModel, [
    { name: "claude-opus-4-5", deltaUsd: 512.4 },
    { name: "claude-sonnet-4-6", deltaUsd: -33.6 },
    { name: "claude-haiku-4-5", deltaUsd: 7.2 },
  ]);
  // A project delta is named on this side: the local label where there is one,
  // a shortened fingerprint where there is not. The `<unknown-project>` bucket
  // is left whole, because truncating it produces a word rather than an id.
  assert.deepEqual(data.changed.byProject, [
    { name: "Payments API", deltaUsd: 480 },
    { name: "667788", deltaUsd: -20 },
    { name: "<unknown-project>", deltaUsd: 12 },
  ]);

  // Aggregate-only: no fingerprint, no report, no window in milliseconds.
  assert.deepEqual(Object.keys(data.changed).sort(), ["byModel", "byProject", "current", "days", "previous"]);
  assert.ok(!JSON.stringify(data.changed).includes("112233445566"), "a full project id never crosses into the section");
  assert.ok(!JSON.stringify(data.changed).includes("report"), "the two nested reports stay on the server");

  // The section is its own hairline block between the readings and the ranking,
  // and it says in the heading that it is descriptive.
  assert.match(page, /<h2 class="micro">what changed \/ where the money moved, not why<\/h2>/);
  assert.ok(page.indexOf('id="changed-section"') > page.indexOf('<section class="readings"'));
  assert.ok(page.indexOf('id="changed-section"') < page.indexOf('id="ranking"'));
  // Direction reads without colour: a leading sign, and ink brightness only.
  assert.match(page, /const signedMoney = value => \(value < 0 \? '−' : '\+'\)/);
  assert.match(page, /\.change-delta \{ text-align:right; color:var\(--ink\); opacity:\.55; \}/);
  assert.ok(!/\.change-delta[^}]*(red|green|#[0-9a-f]{3})/i.test(page), "no hue is introduced for direction");
});

test("a dashboard with no trend to compare renders the section in its empty voice, never hidden", () => {
  // No third argument at all is the legacy call, and the commonest cause is an
  // index with less than two windows of history.
  const bare = renderDashboard(report, { recommendations: [] });
  assert.equal(payloadOf(bare).changed, null);
  assert.match(bare, /id="changed-section"/, "the section still exists");
  assert.match(bare, /'not enough history to compare two windows'/);

  // Two real windows where nothing moved is a different silence, and the page
  // carries a separate sentence for it rather than claiming there is no history.
  const flat = payloadOf(renderDashboard(report, { recommendations: [] }, {}, trendFixture()));
  assert.deepEqual(flat.changed.byModel, []);
  assert.deepEqual(flat.changed.byProject, []);
  assert.match(bare, /'no model or project moved between these two windows'/);
  // Both empties are the page's existing empty voice, not a new one.
  assert.match(bare, /empty\.className = 'empty'/);
});

test("a per-turn figure is three decimals under a dollar, not four", () => {
  // $0.0902 is the reading that made this rule necessary: four decimals on a
  // per-turn cost read as noise. `money` keeps its four for sub-cent figures
  // elsewhere, where dropping them would print a real cost as $0.00.
  const page = renderDashboard(report, { recommendations: [] });
  assert.match(page, /const fineMoney = value => '\$' \+ value\.toFixed\(value < 1 \? 3 : 2\)/);
  assert.match(page, /const money = value => value > 0 && value < 0\.1 \? cents\.format\(value\) : dollars\.format\(value\)/);
  // The reading and its note are both on the fine helper; the legend, the day
  // readout, and the savings reading are all still on `money`.
  assert.match(page, /'per-turn'\)\.textContent = perTurn \? fineMoney\(perTurn\.p50\)/);
  assert.match(page, /'median billed turn \/ mean ' \+ fineMoney\(perTurn\.mean\) \+ ' \/ p90 ' \+ fineMoney\(perTurn\.p90\)/);

  const fineMoney = (value) => `$${value.toFixed(value < 1 ? 3 : 2)}`;
  assert.deepEqual([0.0902, 0.015, 0.0009, 1.5, 12.345].map(fineMoney), ["$0.090", "$0.015", "$0.001", "$1.50", "$12.35"]);
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
