// The dashboard is intentionally a one-page, loopback-only view. It receives
// an already-redacted aggregate report and exposes no API endpoints or files.

import { createServer } from "node:http";

const LOOPBACK_HOST = "127.0.0.1";

function dashboardPayload(report, analysis) {
  return {
    generatedAt: report.generatedAt,
    scope: report.scope,
    total: report.total,
    insights: report.insights,
    byDay: Object.entries(report.byDay)
      .filter(([day]) => /^\d{4}-\d{2}-\d{2}$/.test(day))
      .slice(-60)
      .map(([day, value]) => ({ day, usd: value.usd, tokens: value.usage.total })),
    models: Object.entries(report.byModel).map(([name, value]) => ({ name, usd: value.usd, tokens: value.usage.total, requests: value.requests })).slice(0, 12),
    tools: report.topTools.slice(0, 12).map((tool) => ({ name: tool.name, usd: tool.usd, tokens: tool.usage.total, calls: tool.calls, followOnRequests: tool.followOnRequests })),
    sessions: report.topSessions.slice(0, 12).map((session) => ({ id: session.id, usd: session.usd, tokens: session.usage.total, requests: session.requests })),
    recommendations: analysis.recommendations.map(({ severity, kind, evidence, action }) => ({ severity, kind, evidence, action })),
  };
}

function embeddedJson(value) {
  // Prevent a provider-controlled model or tool name from breaking out of the
  // inert data script. The browser only ever receives aggregate metadata.
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

export function renderDashboard(report, analysis) {
  const data = embeddedJson(dashboardPayload(report, analysis));
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>agent-finops dashboard</title>
  <style>
    :root { color-scheme: dark; --ink:#eef3ff; --muted:#9eabc5; --bg:#0a1020; --panel:#111a2e; --line:#273653; --accent:#79a6ff; --accent-soft:#223d70; --warn:#f5bf65; --danger:#fb8f91; --good:#71d5ad; }
    * { box-sizing:border-box; }
    body { margin:0; background:radial-gradient(circle at top right,#172a50 0,var(--bg) 36rem); color:var(--ink); font:14px/1.45 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    main { max-width:1180px; margin:0 auto; padding:32px 20px 48px; }
    header { display:flex; align-items:flex-start; justify-content:space-between; gap:18px; margin-bottom:26px; }
    h1 { margin:0; font-size:28px; letter-spacing:-.04em; }
    h2 { margin:0; font-size:16px; letter-spacing:-.01em; }
    p { margin:0; color:var(--muted); }
    .eyebrow { color:var(--accent); font-size:12px; font-weight:700; letter-spacing:.09em; text-transform:uppercase; margin-bottom:5px; }
    .status { border:1px solid var(--line); border-radius:999px; color:var(--good); padding:6px 10px; white-space:nowrap; font-size:12px; }
    .metrics { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; margin-bottom:18px; }
    .metric,.panel { border:1px solid var(--line); background:color-mix(in srgb,var(--panel) 92%,transparent); border-radius:14px; }
    .metric { padding:15px; min-height:102px; }
    .metric .label { color:var(--muted); font-size:12px; }
    .metric strong { display:block; font-size:23px; letter-spacing:-.04em; margin:7px 0 2px; }
    .metric small { color:var(--muted); }
    .layout { display:grid; grid-template-columns:minmax(0,1.45fr) minmax(310px,.8fr); gap:18px; }
    .panel { padding:18px; }
    .panel-head { display:flex; justify-content:space-between; align-items:baseline; gap:12px; margin-bottom:15px; }
    .panel-head span { color:var(--muted); font-size:12px; }
    .daily-chart { height:225px; display:flex; align-items:end; gap:3px; border-bottom:1px solid var(--line); padding:10px 2px 0; }
    .day { position:relative; flex:1; min-width:3px; background:linear-gradient(to top,var(--accent),#8fd7ff); border-radius:3px 3px 0 0; cursor:default; }
    .day:hover { filter:brightness(1.22); }
    .day::after { content:attr(data-tip); position:absolute; z-index:3; display:none; bottom:calc(100% + 6px); left:50%; transform:translateX(-50%); background:#050914; border:1px solid var(--line); border-radius:6px; color:var(--ink); padding:4px 6px; white-space:nowrap; font-size:11px; }
    .day:hover::after { display:block; }
    .chart-footer { display:flex; justify-content:space-between; color:var(--muted); font-size:11px; padding-top:8px; }
    .recs { display:grid; gap:10px; }
    .rec { border-left:3px solid var(--line); padding:2px 0 2px 10px; }
    .rec.high { border-color:var(--danger); } .rec.medium { border-color:var(--warn); } .rec.info { border-color:var(--good); }
    .rec b { display:block; font-size:13px; margin-bottom:2px; }
    .rec span { display:block; color:var(--muted); font-size:12px; }
    .rec em { color:var(--ink); display:block; font-style:normal; font-size:12px; margin-top:4px; }
    .rank-panel { margin-top:18px; }
    .switcher { display:flex; gap:5px; flex-wrap:wrap; }
    button { background:transparent; border:1px solid var(--line); border-radius:999px; color:var(--muted); padding:5px 9px; cursor:pointer; font:inherit; font-size:12px; }
    button[aria-pressed="true"] { background:var(--accent-soft); border-color:var(--accent); color:var(--ink); }
    button:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
    .ranking { display:grid; gap:10px; }
    .row { display:grid; grid-template-columns:minmax(165px,1fr) minmax(90px,2.2fr) 82px; align-items:center; gap:10px; }
    .row-label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px; }
    .bar-track { height:10px; border-radius:99px; background:#1c2943; overflow:hidden; }
    .bar { height:100%; width:0; background:linear-gradient(90deg,var(--accent),#8fd7ff); border-radius:inherit; transition:width .18s ease; }
    .row-value { text-align:right; color:var(--muted); font-variant-numeric:tabular-nums; font-size:12px; }
    .detail { margin-top:13px; border-top:1px solid var(--line); padding-top:12px; color:var(--muted); font-size:12px; min-height:31px; }
    footer { color:var(--muted); font-size:11px; margin-top:20px; }
    @media (max-width:800px) { .metrics { grid-template-columns:repeat(2,minmax(0,1fr)); } .layout { grid-template-columns:1fr; } }
    @media (max-width:480px) { main { padding:20px 14px 34px; } header { display:block; } .status { display:inline-block; margin-top:12px; } .row { grid-template-columns:minmax(95px,1fr) minmax(70px,1.6fr) 64px; gap:7px; } .row-label,.row-value { font-size:11px; } }
  </style>
</head>
<body>
  <main>
    <header>
      <div><div class="eyebrow">Private local analytics</div><h1>Agent FinOps</h1><p id="scope"></p></div>
      <div class="status">Loopback only · no uploads</div>
    </header>
    <section class="metrics" aria-label="Cost metrics">
      <article class="metric"><div class="label">Estimated cost</div><strong id="cost"></strong><small id="requests"></small></article>
      <article class="metric"><div class="label">Token volume</div><strong id="tokens"></strong><small>all cache classes included</small></article>
      <article class="metric"><div class="label">Cache-read share</div><strong id="cache"></strong><small>prompt-token reuse</small></article>
      <article class="metric"><div class="label">Output-cost share</div><strong id="output"></strong><small>generated-response cost</small></article>
    </section>
    <section class="layout">
      <article class="panel"><div class="panel-head"><h2>Daily estimated cost</h2><span id="daily-total"></span></div><div class="daily-chart" id="daily-chart" aria-label="Daily estimated cost chart"></div><div class="chart-footer"><span id="first-day"></span><span id="last-day"></span></div></article>
      <article class="panel"><div class="panel-head"><h2>Where to investigate</h2><span>evidence, not causation</span></div><div class="recs" id="recommendations"></div></article>
    </section>
    <section class="panel rank-panel"><div class="panel-head"><h2 id="rank-title">Cost concentration</h2><div class="switcher" role="group" aria-label="Cost breakdown"><button type="button" data-mode="models" aria-pressed="true">Models</button><button type="button" data-mode="tools" aria-pressed="false">Tools & MCPs</button><button type="button" data-mode="sessions" aria-pressed="false">Sessions</button></div></div><div class="ranking" id="ranking"></div><div class="detail" id="detail">Select a row to inspect its aggregate metadata.</div></section>
    <footer id="footer"></footer>
  </main>
  <script>
    const DATA = ${data};
    const dollars = new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2});
    const integer = new Intl.NumberFormat('en-US',{maximumFractionDigits:0});
    const percent = value => value == null ? 'n/a' : (value * 100).toFixed(1) + '%';
    const tokenLabel = value => value >= 1e9 ? (value / 1e9).toFixed(2) + 'B' : value >= 1e6 ? (value / 1e6).toFixed(1) + 'M' : integer.format(value);
    document.getElementById('scope').textContent = integer.format(DATA.scope.recordsAfterDateFilter) + ' usage records · refreshed ' + new Date(DATA.generatedAt).toLocaleString();
    document.getElementById('cost').textContent = dollars.format(DATA.total.usd);
    document.getElementById('requests').textContent = integer.format(DATA.total.requests) + ' billed turns';
    document.getElementById('tokens').textContent = tokenLabel(DATA.total.usage.total);
    document.getElementById('cache').textContent = percent(DATA.insights.cacheReadShare);
    document.getElementById('output').textContent = percent(DATA.insights.outputCostShare);
    const days = DATA.byDay;
    const maxDay = Math.max(1,...days.map(day => day.usd));
    const chart = document.getElementById('daily-chart');
    for (const day of days) { const bar = document.createElement('div'); bar.className = 'day'; bar.style.height = Math.max(2,(day.usd / maxDay) * 100) + '%'; bar.dataset.tip = day.day + ' · ' + dollars.format(day.usd) + ' · ' + tokenLabel(day.tokens) + ' tokens'; chart.append(bar); }
    document.getElementById('daily-total').textContent = days.length ? dollars.format(days.reduce((sum,day) => sum + day.usd,0)) + ' across shown days' : 'no dated records';
    document.getElementById('first-day').textContent = days[0]?.day || '';
    document.getElementById('last-day').textContent = days.at(-1)?.day || '';
    const recs = document.getElementById('recommendations');
    for (const rec of DATA.recommendations) { const row = document.createElement('div'); row.className = 'rec ' + rec.severity; const title = document.createElement('b'); title.textContent = rec.kind.replaceAll('-', ' '); const evidence = document.createElement('span'); evidence.textContent = rec.evidence; const action = document.createElement('em'); action.textContent = rec.action; row.append(title,evidence,action); recs.append(row); }
    if (!DATA.recommendations.length) recs.textContent = 'No threshold-based hotspots in this period.';
    const labels = { models:'Models by estimated cost', tools:'Tool and MCP follow-on cohorts', sessions:'Most expensive anonymous sessions' };
    const detailText = item => ({ models:item.requests + ' billed turns · ' + tokenLabel(item.tokens) + ' tokens', tools:item.calls + ' calls · ' + item.followOnRequests + ' following billed turns · attribution is correlation', sessions:item.requests + ' billed turns · ' + tokenLabel(item.tokens) + ' tokens' });
    function renderRanking(mode) {
      document.getElementById('rank-title').textContent = labels[mode];
      const target = document.getElementById('ranking'); target.replaceChildren();
      const rows = DATA[mode]; const max = Math.max(1,...rows.map(row => row.usd));
      for (const item of rows) { const row = document.createElement('button'); row.type = 'button'; row.className = 'row'; row.setAttribute('aria-label',(item.name || item.id) + ', ' + dollars.format(item.usd)); const label = document.createElement('span'); label.className = 'row-label'; label.textContent = item.name || item.id; const track = document.createElement('span'); track.className = 'bar-track'; const bar = document.createElement('span'); bar.className = 'bar'; bar.style.width = (item.usd / max * 100) + '%'; track.append(bar); const value = document.createElement('span'); value.className = 'row-value'; value.textContent = dollars.format(item.usd); row.append(label,track,value); row.addEventListener('click',() => { document.getElementById('detail').textContent = (item.name || item.id) + ' · ' + detailText(item)[mode]; }); target.append(row); }
      if (!rows.length) target.textContent = 'No data in this scope.';
    }
    for (const button of document.querySelectorAll('[data-mode]')) button.addEventListener('click',() => { for (const other of document.querySelectorAll('[data-mode]')) other.setAttribute('aria-pressed','false'); button.setAttribute('aria-pressed','true'); renderRanking(button.dataset.mode); });
    renderRanking('models');
    document.getElementById('footer').textContent = 'Rendered from the private metadata index. No prompts, responses, arguments, tool results, source paths, or network calls are included. Tool/MCP values allocate only the immediate following billed turn.';
  </script>
</body>
</html>`;
}

export async function startDashboard(report, analysis, { port = 7474 } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be an integer from 0 to 65535.");
  const page = renderDashboard(report, analysis);
  const server = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/") {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found\n");
      return;
    }
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    });
    response.end(page);
  });
  return await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: LOOPBACK_HOST, port }, () => {
      server.off("error", reject);
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      const scheme = "http";
      resolve({ server, url: `${scheme}://${LOOPBACK_HOST}:${actualPort}/` });
    });
  });
}
