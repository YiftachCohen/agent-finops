// The dashboard is intentionally a one-page, loopback-only view. It receives
// an already-redacted aggregate report and exposes no API endpoints or files.

import { createServer } from "node:http";

const LOOPBACK_HOST = "127.0.0.1";

// Every bucket in the report carries the same four token classes. The dashboard
// draws them everywhere, so normalize once here and tolerate older indexes that
// only recorded a total.
function usageOf(usage = {}) {
  return {
    input: usage.input || 0,
    cacheCreate: usage.cacheCreate || 0,
    cacheRead: usage.cacheRead || 0,
    output: usage.output || 0,
    total: usage.total || 0,
  };
}

function dashboardPayload(report, analysis) {
  return {
    generatedAt: report.generatedAt,
    // Only the scan timestamp, never the index path: the page is a screenshot
    // candidate and an absolute path carries the local username.
    scannedAt: report.index?.scannedAt || null,
    scope: report.scope,
    total: { ...report.total, usage: usageOf(report.total.usage) },
    insights: report.insights,
    diagnostics: {
      duplicatesDropped: report.diagnostics?.duplicatesDropped || 0,
      missingIds: report.diagnostics?.missingIds || 0,
      unpricedTokens: report.total.unpricedTokens || 0,
    },
    byDay: Object.entries(report.byDay)
      .filter(([day]) => /^\d{4}-\d{2}-\d{2}$/.test(day))
      .slice(-60)
      .map(([day, value]) => ({ day, usd: value.usd, usage: usageOf(value.usage) })),
    models: Object.entries(report.byModel).map(([name, value]) => ({ name, usd: value.usd, usage: usageOf(value.usage), requests: value.requests })).slice(0, 12),
    tools: report.topTools.slice(0, 12).map((tool) => ({ name: tool.name, usd: tool.usd, usage: usageOf(tool.usage), calls: tool.calls, followOnRequests: tool.followOnRequests })),
    sessions: report.topSessions.slice(0, 12).map((session) => ({ id: session.id, usd: session.usd, usage: usageOf(session.usage), requests: session.requests })),
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
  <title>agent-finops meter</title>
  <style>
    :root {
      color-scheme: light dark;
      /* Enamel instrument face. The token-class ramp runs light to dark in the
         order cache-read, input, cache-write, output: palest is cheapest. */
      --face:#e9e7e0; --face-edge:#dad7cd; --well:#f1efe9; --rule:#c5c1b3; --hair:#d5d1c5;
      --ink:#16191b; --ink-soft:#3d4448; --muted:#5f6569;
      --cache-read:#b6bcae; --input:#7b9a91; --cache-write:#3d6068; --output:#17262b; --unknown:#9aa39d;
      --signal:#a8781a; --alert:#9c3a1f; --secure:#3f6b4e;
      --plate:#f2f0ea;
      --font-plate:"Bahnschrift","Avenir Next Condensed","HelveticaNeue-CondensedBold","Arial Narrow",Inter,system-ui,sans-serif;
      --font-read:ui-monospace,"SF Mono",Menlo,"Cascadia Mono","DejaVu Sans Mono",Consolas,monospace;
      --font-text:"Helvetica Neue",Inter,system-ui,-apple-system,"Segoe UI",sans-serif;
      --strip-h:172px;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --face:#14171a; --face-edge:#0c0f11; --well:#0b0e10; --rule:#333c41; --hair:#242c30;
        --ink:#e8eae7; --ink-soft:#b3bcbd; --muted:#8b9298;
        --cache-read:#4c6668; --input:#6f958c; --cache-write:#a7c4b8; --output:#eceee2; --unknown:#6c7a7b;
        --signal:#dda63c; --alert:#e0724c; --secure:#71b98d;
        --plate:#1a1e21;
      }
    }
    * { box-sizing:border-box; }
    body {
      margin:0; background:var(--face); color:var(--ink);
      font:12.5px/1.5 var(--font-text);
      -webkit-font-smoothing:antialiased;
    }
    .rig { max-width:1120px; margin:0 auto; padding:34px 24px 40px; }

    /* Nameplate */
    .nameplate { display:flex; align-items:flex-end; justify-content:space-between; gap:20px; padding-bottom:14px; border-bottom:1px solid var(--ink); }
    h1 { margin:0; font-family:var(--font-plate); font-size:27px; font-weight:700; text-transform:uppercase; letter-spacing:.07em; line-height:1; }
    .sub { margin:6px 0 0; color:var(--muted); font-family:var(--font-read); font-size:11.5px; letter-spacing:-.01em; }
    .stale { color:var(--alert); }
    .seal { display:flex; align-items:center; gap:7px; flex:none; font-family:var(--font-plate); font-size:11px; text-transform:uppercase; letter-spacing:.13em; color:var(--secure); padding-bottom:2px; }
    .lamp { width:7px; height:7px; flex:none; background:currentColor; }

    .unit { font-family:var(--font-plate); font-size:10.5px; font-weight:600; text-transform:uppercase; letter-spacing:.15em; color:var(--muted); }

    /* Primary reading and the register strip */
    .reading { padding:22px 0 0; }
    .reading-head { display:flex; align-items:flex-end; justify-content:space-between; gap:24px; flex-wrap:wrap; margin-bottom:18px; }
    .figure { font-family:var(--font-read); font-size:clamp(42px,6.4vw,66px); font-weight:500; letter-spacing:-.035em; line-height:.94; font-variant-numeric:tabular-nums; margin:8px 0 6px; }
    .legend { list-style:none; display:flex; flex-wrap:wrap; gap:2px 18px; margin:0; padding:0; }
    .legend li { display:flex; align-items:center; gap:7px; font-family:var(--font-read); font-size:11px; color:var(--muted); font-variant-numeric:tabular-nums; }
    .legend i { width:8px; height:8px; flex:none; font-style:normal; }
    .legend b { color:var(--ink); font-weight:500; }

    .strip { position:relative; height:var(--strip-h); background:var(--well); border:1px solid var(--rule); box-shadow:inset 0 1px 2px rgba(0,0,0,.07); padding:16px 8px 0; }
    /* Graduations turn the empty headroom into a readable scale instead of a void. */
    .grads { position:absolute; inset:16px 8px 0; display:flex; flex-direction:column; justify-content:space-between; pointer-events:none; }
    .grads i { display:block; border-top:1px dashed var(--hair); }
    .grads i:last-child { border-top-style:solid; border-top-color:var(--rule); }
    .peak { position:absolute; top:2px; right:9px; font-family:var(--font-plate); font-size:10px; text-transform:uppercase; letter-spacing:.13em; color:var(--muted); }
    .ribbon { position:relative; display:flex; align-items:flex-end; gap:2px; height:100%; }
    .ribbon:focus-visible { outline:2px solid var(--signal); outline-offset:3px; }
    /* The needle alone marks the read day; a second highlight would be noise. */
    /* Capped so a two-day window reads as bars on a scale, not a filled block. */
    .seg { position:relative; flex:1 1 0; max-width:72px; min-width:2px; min-height:2px; display:flex; flex-direction:column-reverse; background:var(--hair); cursor:crosshair; }
    .seg span { display:block; width:100%; }
    .needle { position:absolute; top:16px; bottom:0; width:1px; background:var(--signal); pointer-events:none; opacity:0; transform:translateX(-1px); transition:transform .12s ease, opacity .12s ease; }
    .needle.on { opacity:1; }
    .axis { display:flex; justify-content:space-between; gap:14px; margin-top:9px; }
    .axis span { font-family:var(--font-read); font-size:10.5px; color:var(--muted); }
    .axis .unit { font-family:var(--font-plate); }
    .readout { margin:12px 0 0; font-family:var(--font-read); font-size:12px; color:var(--ink-soft); font-variant-numeric:tabular-nums; min-height:18px; }

    /* Hairline gauge row — readings, not cards */
    .gauges { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); margin:26px 0 30px; border-top:1px solid var(--rule); border-bottom:1px solid var(--rule); }
    .gauge { padding:14px 18px; border-left:1px solid var(--hair); }
    .gauge:first-child { border-left:0; padding-left:0; }
    .gauge b { display:block; font-family:var(--font-read); font-size:22px; font-weight:500; letter-spacing:-.02em; font-variant-numeric:tabular-nums; margin:7px 0 4px; }
    .gauge small { color:var(--muted); font-size:11px; }

    /* Panels */
    .columns { display:grid; grid-template-columns:minmax(0,1.4fr) minmax(300px,.92fr); gap:34px; align-items:start; }
    .panel-head { display:flex; align-items:baseline; justify-content:space-between; gap:14px; padding-bottom:9px; border-bottom:1px solid var(--ink); margin-bottom:14px; }
    h2 { margin:0; font-family:var(--font-plate); font-size:13px; font-weight:700; text-transform:uppercase; letter-spacing:.11em; }
    .switcher { display:flex; gap:0; flex:none; }
    .switcher button { background:transparent; border:1px solid var(--hair); border-left-width:0; color:var(--muted); padding:4px 10px 3px; cursor:pointer; font-family:var(--font-plate); font-size:10.5px; text-transform:uppercase; letter-spacing:.1em; }
    .switcher button:first-child { border-left-width:1px; }
    .switcher button[aria-pressed="true"] { background:var(--ink); border-color:var(--ink); color:var(--plate); }
    .switcher button:focus-visible { outline:2px solid var(--signal); outline-offset:2px; }

    .ranking { display:grid; }
    .row { position:relative; display:grid; grid-template-columns:minmax(110px,1.05fr) minmax(80px,1.9fr) 78px; align-items:center; gap:14px; width:100%; text-align:left; background:transparent; border:0; border-bottom:1px solid var(--hair); padding:9px 0 9px 14px; cursor:pointer; color:inherit; font:inherit; }
    .row:hover .row-label, .row[aria-current="true"] .row-label { color:var(--ink); }
    .row[aria-current="true"]::before { content:"\\203A"; position:absolute; left:2px; color:var(--signal); }
    .row:focus-visible { outline:2px solid var(--signal); outline-offset:1px; }
    .row-label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:var(--font-read); font-size:11.5px; color:var(--ink-soft); }
    .track { display:flex; height:11px; background:var(--well); box-shadow:inset 0 0 0 1px var(--hair); overflow:hidden; }
    .track span { display:block; width:0; transition:width .5s cubic-bezier(.2,.7,.3,1); }
    .row-value { text-align:right; font-family:var(--font-read); font-size:11.5px; font-variant-numeric:tabular-nums; }
    .detail { margin:12px 0 0; font-family:var(--font-read); font-size:11px; line-height:1.65; color:var(--muted); white-space:pre-line; min-height:30px; }
    .empty { padding:14px 0; color:var(--muted); }

    /* Investigation notes */
    .notes { display:grid; gap:16px; }
    .note-head { display:flex; align-items:center; gap:8px; margin-bottom:5px; }
    .note-head .lamp { color:var(--muted); }
    .note.high .lamp { color:var(--alert); }
    .note.medium .lamp { color:var(--signal); }
    .note.info .lamp { color:var(--secure); }
    .note-head b { font-family:var(--font-plate); font-size:13px; font-weight:700; text-transform:uppercase; letter-spacing:.08em; }
    .note-head .sev { margin-left:auto; font-family:var(--font-plate); font-size:10px; text-transform:uppercase; letter-spacing:.13em; color:var(--muted); }
    .note p { margin:0; color:var(--muted); }
    .note .next { margin-top:7px; padding-left:11px; border-left:1px solid var(--rule); color:var(--ink-soft); }

    .colophon { margin-top:34px; padding-top:12px; border-top:1px solid var(--hair); display:flex; gap:20px; justify-content:space-between; flex-wrap:wrap; }
    .colophon p { margin:0; max-width:62ch; color:var(--muted); font-size:11px; }
    .colophon .unit { flex:none; }

    @media (prefers-reduced-motion: no-preference) {
      .ribbon { animation:sweep .6s cubic-bezier(.2,.7,.3,1) both; }
      @keyframes sweep { from { clip-path:inset(0 100% 0 0); } to { clip-path:inset(0 0 0 0); } }
    }
    @media (prefers-reduced-motion: reduce) { .track span { transition:none; } }

    @media (max-width:860px) {
      .columns { grid-template-columns:1fr; gap:30px; }
      .gauges { grid-template-columns:repeat(2,minmax(0,1fr)); }
      .gauge:nth-child(3) { border-left:0; padding-left:0; }
      .gauge:nth-child(-n+2) { border-bottom:1px solid var(--hair); }
    }
    @media (max-width:520px) {
      :root { --strip-h:132px; }
      .rig { padding:24px 16px 32px; }
      .nameplate { display:block; }
      .seal { margin-top:12px; padding-bottom:0; }
      /* The readout below already names the unit; three-up axis text does not fit. */
      .axis .unit { display:none; }
      .row { grid-template-columns:minmax(80px,1fr) minmax(50px,1.2fr) 64px; gap:9px; }
    }
  </style>
</head>
<body>
  <div class="rig">
    <header class="nameplate">
      <div>
        <h1>Agent FinOps</h1>
        <p class="sub" id="scope"></p>
      </div>
      <div class="seal"><span class="lamp"></span>Loopback only · no uploads</div>
    </header>

    <section class="reading" aria-label="Estimated cost over the reporting window">
      <div class="reading-head">
        <div>
          <div class="unit">Estimated cost · USD</div>
          <div class="figure" id="cost">—</div>
          <div class="sub" id="requests"></div>
        </div>
        <ul class="legend" id="legend" aria-label="Token classes"></ul>
      </div>
      <div class="strip">
        <div class="grads" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
        <div class="ribbon" id="ribbon" tabindex="0" role="img" aria-label="Daily estimated cost"></div>
        <div class="needle" id="needle"></div>
        <div class="peak" id="peak"></div>
      </div>
      <div class="axis"><span id="first-day"></span><span class="unit" id="strip-unit"></span><span id="last-day"></span></div>
      <p class="readout" id="readout"></p>
    </section>

    <section class="gauges" aria-label="Rates and shares">
      <div class="gauge"><div class="unit">Token volume</div><b id="tokens">—</b><small>input + cache + output</small></div>
      <div class="gauge"><div class="unit">Cache-read share</div><b id="cache">—</b><small>of prompt tokens</small></div>
      <div class="gauge"><div class="unit">Output-cost share</div><b id="output">—</b><small>of estimated spend</small></div>
      <div class="gauge"><div class="unit">Cost per turn</div><b id="per-turn">—</b><small>mean billed turn</small></div>
    </section>

    <section class="columns">
      <article class="panel">
        <div class="panel-head">
          <h2 id="rank-title">Models by estimated cost</h2>
          <div class="switcher" role="group" aria-label="Cost breakdown">
            <button type="button" data-mode="models" aria-pressed="true">Models</button>
            <button type="button" data-mode="tools" aria-pressed="false">Tools &amp; MCPs</button>
            <button type="button" data-mode="sessions" aria-pressed="false">Sessions</button>
          </div>
        </div>
        <div class="ranking" id="ranking"></div>
        <p class="detail" id="detail">Pick a row to read its token mix.</p>
      </article>
      <article class="panel">
        <div class="panel-head"><h2>Where to investigate</h2><span class="unit">evidence, not causation</span></div>
        <div class="notes" id="recommendations"></div>
      </article>
    </section>

    <div class="colophon">
      <p id="colophon-text"></p>
      <div class="unit" id="colophon-notes"></div>
    </div>
  </div>
  <script>
    const DATA = ${data};
    const CLASSES = [
      { key:'cacheRead', label:'cache read', color:'var(--cache-read)' },
      { key:'input', label:'input', color:'var(--input)' },
      { key:'cacheCreate', label:'cache write', color:'var(--cache-write)' },
      { key:'output', label:'output', color:'var(--output)' },
    ];
    const dollars = new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2});
    const cents = new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:4});
    const integer = new Intl.NumberFormat('en-US',{maximumFractionDigits:0});
    const percent = value => value == null ? 'n/a' : (value * 100).toFixed(1) + '%';
    // Sub-cent turn costs are common; showing them as $0.00 would read as free.
    const money = value => value > 0 && value < 0.1 ? cents.format(value) : dollars.format(value);
    const tokenLabel = value => value >= 1e9 ? (value / 1e9).toFixed(2) + 'B' : value >= 1e6 ? (value / 1e6).toFixed(1) + 'M' : value >= 1e4 ? (value / 1e3).toFixed(0) + 'K' : integer.format(value);
    const classSum = usage => CLASSES.reduce((sum,item) => sum + (usage[item.key] || 0), 0);
    const count = (value,noun) => integer.format(value) + ' ' + noun + (value === 1 ? '' : 's');

    // The scope line is the tell for a stale or empty read, so it states what is
    // in the window, what the whole index holds, and when it was last scanned.
    // "1 usage records" alone looks like a quiet month rather than a bad index.
    const scanned = DATA.scannedAt ? new Date(DATA.scannedAt) : null;
    const scopeParts = [count(DATA.scope.recordsAfterDateFilter,'usage record') + ' in window'];
    if (Number.isFinite(DATA.scope.recordsRead) && DATA.scope.recordsRead !== DATA.scope.recordsAfterDateFilter) scopeParts.push(integer.format(DATA.scope.recordsRead) + ' indexed');
    scopeParts.push(scanned ? 'scanned ' + scanned.toLocaleString() : 'read ' + new Date(DATA.generatedAt).toLocaleString());
    const scopeLine = document.getElementById('scope');
    scopeLine.textContent = scopeParts.join(' · ');
    const staleMs = scanned ? new Date(DATA.generatedAt) - scanned : 0;
    if (staleMs > 3600000) {
      const warn = document.createElement('span');
      warn.className = 'stale';
      warn.textContent = ' · index is ' + Math.round(staleMs / 3600000) + 'h old — rerun with --fresh';
      scopeLine.append(warn);
    }
    document.getElementById('cost').textContent = dollars.format(DATA.total.usd);
    document.getElementById('requests').textContent = count(DATA.total.requests,'billed turn') + ' · ' + count(DATA.byDay.length,'day') + ' shown';
    document.getElementById('tokens').textContent = tokenLabel(DATA.total.usage.total);
    document.getElementById('cache').textContent = percent(DATA.insights.cacheReadShare);
    document.getElementById('output').textContent = percent(DATA.insights.outputCostShare);
    document.getElementById('per-turn').textContent = DATA.total.requests ? money(DATA.total.usd / DATA.total.requests) : 'n/a';

    // Legend doubles as the token-class breakdown, so the ramp is readable
    // before anyone hovers a segment.
    const legend = document.getElementById('legend');
    for (const item of CLASSES) {
      const entry = document.createElement('li');
      const swatch = document.createElement('i'); swatch.style.background = item.color;
      const name = document.createElement('span'); name.textContent = item.label;
      const value = document.createElement('b'); value.textContent = tokenLabel(DATA.total.usage[item.key] || 0);
      entry.append(swatch,name,value); legend.append(entry);
    }

    // Bar height reads estimated cost. When nothing in the window is priced,
    // fall back to token volume rather than drawing a flat, meaningless line.
    const days = DATA.byDay;
    const costTotal = days.reduce((sum,day) => sum + day.usd,0);
    const metric = costTotal > 0 ? 'usd' : 'tokens';
    const valueOf = day => metric === 'usd' ? day.usd : day.usage.total;
    const maxDay = Math.max(0,...days.map(valueOf));
    const ribbon = document.getElementById('ribbon');
    const needle = document.getElementById('needle');
    const readout = document.getElementById('readout');
    const segments = [];
    for (const day of days) {
      const seg = document.createElement('div');
      seg.className = 'seg';
      seg.style.height = (maxDay > 0 ? Math.max(1,(valueOf(day) / maxDay) * 100) : 1) + '%';
      const total = classSum(day.usage);
      for (const item of (total > 0 ? CLASSES : [])) {
        const block = document.createElement('span');
        block.style.flexGrow = String(day.usage[item.key] || 0);
        block.style.background = item.color;
        seg.append(block);
      }
      if (total === 0 && day.usage.total > 0) { const block = document.createElement('span'); block.style.flexGrow = '1'; block.style.background = 'var(--unknown)'; seg.append(block); }
      segments.push(seg); ribbon.append(seg);
    }
    let active = -1;
    function readDay(index) {
      if (!days.length) return;
      active = Math.max(0,Math.min(days.length - 1,index));
      const seg = segments[active]; const day = days[active];
      needle.classList.add('on');
      needle.style.transform = 'translateX(' + (seg.offsetLeft + seg.offsetWidth / 2) + 'px)';
      const share = classSum(day.usage) > 0 ? ' · ' + percent(day.usage.output / classSum(day.usage)) + ' output tokens' : '';
      readout.textContent = day.day + ' · ' + money(day.usd) + ' · ' + tokenLabel(day.usage.total) + ' tokens' + share;
    }
    segments.forEach((seg,index) => seg.addEventListener('pointerenter',() => readDay(index)));
    ribbon.addEventListener('keydown',(event) => {
      const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (!step) return;
      event.preventDefault();
      readDay(active < 0 ? days.length - 1 : active + step);
    });
    ribbon.setAttribute('aria-label',days.length ? 'Daily ' + (metric === 'usd' ? 'estimated cost' : 'token volume') + ' from ' + days[0].day + ' to ' + days.at(-1).day + '. Use arrow keys to read a day.' : 'No dated records in this window.');
    document.getElementById('strip-unit').textContent = !days.length ? 'no dated records' : metric === 'usd' ? 'height: daily cost · fill: token mix' : 'height: daily tokens · no priced cost in this window';
    document.getElementById('peak').textContent = maxDay > 0 ? 'peak ' + (metric === 'usd' ? money(maxDay) : tokenLabel(maxDay) + ' tokens') : '';
    document.getElementById('first-day').textContent = days[0]?.day || '';
    document.getElementById('last-day').textContent = days.at(-1)?.day || '';
    if (days.length) readDay(days.length - 1); else readout.textContent = 'Nothing to read in this window. Widen it with --since.';

    const recs = document.getElementById('recommendations');
    for (const rec of DATA.recommendations) {
      const note = document.createElement('div'); note.className = 'note ' + rec.severity;
      const head = document.createElement('div'); head.className = 'note-head';
      const lamp = document.createElement('span'); lamp.className = 'lamp';
      const title = document.createElement('b'); title.textContent = rec.kind.replaceAll('-',' ');
      const severity = document.createElement('span'); severity.className = 'sev'; severity.textContent = rec.severity;
      head.append(lamp,title,severity);
      const evidence = document.createElement('p'); evidence.textContent = rec.evidence;
      const action = document.createElement('p'); action.className = 'next'; action.textContent = rec.action;
      note.append(head,evidence,action); recs.append(note);
    }
    if (!DATA.recommendations.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = 'Nothing crossed a hotspot threshold in this window.'; recs.append(empty); }

    const labels = { models:'Models by estimated cost', tools:'Tool and MCP follow-on cohorts', sessions:'Most expensive anonymous sessions' };
    const detailText = { models:item => count(item.requests,'billed turn'), tools:item => count(item.calls,'call') + ' · ' + count(item.followOnRequests,'following billed turn') + ' · attribution is correlation', sessions:item => count(item.requests,'billed turn') };
    function renderRanking(mode) {
      document.getElementById('rank-title').textContent = labels[mode];
      const target = document.getElementById('ranking'); target.replaceChildren();
      document.getElementById('detail').textContent = 'Pick a row to read its token mix.';
      const rows = DATA[mode]; const max = Math.max(0,...rows.map(row => row.usd));
      if (!rows.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = 'No rows in this window.'; target.append(empty); return; }
      for (const item of rows) {
        const row = document.createElement('button'); row.type = 'button'; row.className = 'row';
        row.setAttribute('aria-label',(item.name || item.id) + ', ' + dollars.format(item.usd));
        const label = document.createElement('span'); label.className = 'row-label'; label.textContent = item.name || item.id;
        const track = document.createElement('span'); track.className = 'track';
        const total = classSum(item.usage);
        const width = max > 0 ? item.usd / max : 0;
        const blocks = [];
        for (const cls of (total > 0 ? CLASSES : [])) { const block = document.createElement('span'); block.style.background = cls.color; blocks.push([block,(item.usage[cls.key] || 0) / total * width * 100]); track.append(block); }
        if (total === 0) { const block = document.createElement('span'); block.style.background = 'var(--unknown)'; blocks.push([block,width * 100]); track.append(block); }
        requestAnimationFrame(() => { for (const [block,pct] of blocks) block.style.width = pct + '%'; });
        const value = document.createElement('span'); value.className = 'row-value'; value.textContent = dollars.format(item.usd);
        row.append(label,track,value);
        row.addEventListener('click',() => {
          for (const other of target.querySelectorAll('.row')) other.removeAttribute('aria-current');
          row.setAttribute('aria-current','true');
          const mix = total > 0 ? CLASSES.map(cls => cls.label + ' ' + percent((item.usage[cls.key] || 0) / total)).join(' · ') : 'token classes not recorded';
          document.getElementById('detail').textContent = (item.name || item.id) + ' — ' + tokenLabel(item.usage.total) + ' tokens · ' + detailText[mode](item) + '\\n' + mix;
        });
        target.append(row);
      }
    }
    for (const button of document.querySelectorAll('[data-mode]')) button.addEventListener('click',() => { for (const other of document.querySelectorAll('[data-mode]')) other.setAttribute('aria-pressed','false'); button.setAttribute('aria-pressed','true'); renderRanking(button.dataset.mode); });
    renderRanking('models');

    document.getElementById('colophon-text').textContent = 'Rendered from the private metadata index. No prompts, responses, arguments, tool results, source paths, or outbound calls are included. Tool and MCP values allocate only the immediately following billed turn, so they show cohorts, not invoice lines.';
    const notes = [];
    if (DATA.diagnostics.duplicatesDropped) notes.push(count(DATA.diagnostics.duplicatesDropped,'streaming duplicate') + ' collapsed');
    if (DATA.diagnostics.missingIds) notes.push(count(DATA.diagnostics.missingIds,'record') + ' kept without a full dedup key');
    if (DATA.diagnostics.unpricedTokens) notes.push(tokenLabel(DATA.diagnostics.unpricedTokens) + ' tokens from unpriced models');
    document.getElementById('colophon-notes').textContent = notes.length ? notes.join(' · ') : 'no accounting warnings';
  </script>
</body>
</html>`;
}

/**
 * Binding to loopback stops the LAN from reaching the page, but not a public
 * site that resolves its own name to 127.0.0.1: the browser would treat it as
 * same-origin and could read this page. Only serve a loopback Host.
 */
function isLoopbackHost(host, port) {
  if (typeof host !== "string") return false;
  const [name] = host.startsWith("[") ? [host.slice(0, host.indexOf("]") + 1)] : host.split(":");
  const requestedPort = host.slice(name.length).replace(/^:/, "");
  if (requestedPort && Number(requestedPort) !== port) return false;
  return name === LOOPBACK_HOST || name === "localhost" || name === "[::1]";
}

export async function startDashboard(report, analysis, { port = 7474 } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be an integer from 0 to 65535.");
  const page = renderDashboard(report, analysis);
  const server = createServer((request, response) => {
    if (!isLoopbackHost(request.headers.host, server.address()?.port ?? port)) {
      response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Forbidden: this dashboard only answers loopback requests.\n");
      return;
    }
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
