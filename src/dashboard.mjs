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

// The dollar split every bar on the page is drawn from. Only the four charged
// classes travel: they sum to the row's estimate exactly, whereas the per-TTL
// cache-write rows are a breakdown of one of them and would double-count as a
// bar segment. Older buckets carry no split at all, and get zeroes so the bar
// falls back to its unpriced form rather than inventing a shape.
function usdByClassOf(usdByClass = {}) {
  return {
    input: usdByClass?.input || 0,
    cacheWrite: usdByClass?.cacheWrite || 0,
    cacheRead: usdByClass?.cacheRead || 0,
    output: usdByClass?.output || 0,
  };
}

/**
 * What the ranked findings are worth in total, and how many rows carry a figure.
 * The analysis already computes the sum; it is recomputed here only for an
 * analysis built before that field existed, so an older tag-shaped payload reads
 * as a real zero rather than a missing one. Never a total of the window: it sums
 * only the findings a counterfactual could be defended for.
 */
function savingsOf(analysis) {
  const quantified = (analysis?.recommendations || []).filter((item) => item.estimatedSavingsUsd != null);
  return {
    totalUsd: analysis?.totalEstimatedSavingsUsd ?? quantified.reduce((sum, item) => sum + item.estimatedSavingsUsd, 0),
    quantifiedFindings: quantified.length,
  };
}

// Three rows a side. Past that the deltas are usually rounding against the
// headline, and the section stops being an answer to "what changed".
const CHANGED_ROW_LIMIT = 3;

/** A 12-hex fingerprint shortened the way a session row shortens it; anything
 * else — the `<unknown-project>` bucket — is left alone, because truncating it
 * produces a word rather than an id. */
function shortProjectId(id) {
  return /^[a-f0-9]{12}$/i.test(id) ? id.slice(0, 6) : id;
}

/**
 * The two windows `analyzeTrend` compared, reduced to what the page draws: the
 * model and project rows whose dollars moved most, each already named. The two
 * nested reports stay on this side of the wire — the page needs the deltas, not
 * a second copy of every bucket — and a project delta is resolved to its local
 * label here, so no fingerprint has to travel for the row to be readable.
 *
 * Null when the caller has no trend at all, which is what a too-short history
 * produces; the page renders its empty state rather than hiding the section.
 */
function changedOf(trend, labels) {
  if (!trend) return null;
  const rows = (list, name) => list.slice(0, CHANGED_ROW_LIMIT).map((row) => ({ name: name(row), deltaUsd: row.deltaUsd }));
  return {
    days: trend.days,
    current: { start: trend.current?.start || null, end: trend.current?.end || null },
    previous: { start: trend.previous?.start || null, end: trend.previous?.end || null },
    byModel: rows(trend.drivers?.byModel || [], (row) => String(row.model)),
    byProject: rows(trend.drivers?.byProject || [], (row) => labels[row.id] || shortProjectId(String(row.id))),
  };
}

function dashboardPayload(report, analysis, labels, trend) {
  return {
    generatedAt: report.generatedAt,
    // Only the scan timestamp, never the index path: the page is a screenshot
    // candidate and an absolute path carries the local username.
    scannedAt: report.index?.scannedAt || null,
    scope: report.scope,
    total: { ...report.total, usage: usageOf(report.total.usage), usdByClass: usdByClassOf(report.total.usdByClass) },
    insights: report.insights,
    diagnostics: {
      duplicatesDropped: report.diagnostics?.duplicatesDropped || 0,
      missingIds: report.diagnostics?.missingIds || 0,
      unpricedTokens: report.total.unpricedTokens || 0,
    },
    byDay: Object.entries(report.byDay)
      .filter(([day]) => /^\d{4}-\d{2}-\d{2}$/.test(day))
      .slice(-60)
      .map(([day, value]) => ({ day, usd: value.usd, outputUsd: value.outputUsd || 0, usdByClass: usdByClassOf(value.usdByClass), usage: usageOf(value.usage) })),
    models: Object.entries(report.byModel).map(([name, value]) => ({ name, usd: value.usd, outputUsd: value.outputUsd || 0, usdByClass: usdByClassOf(value.usdByClass), usage: usageOf(value.usage), requests: value.requests })).slice(0, 12),
    tools: report.topTools.slice(0, 12).map((tool) => ({
      name: tool.name,
      usd: tool.usd,
      outputUsd: tool.outputUsd || 0,
      usdByClass: usdByClassOf(tool.usdByClass),
      usage: usageOf(tool.usage),
      calls: tool.calls,
      followOnRequests: tool.followOnRequests,
      // Absent on a report built before this field existed (an older tag
      // snapshot); the row falls back to "n/a" rather than a divide-by-zero.
      usdPerCall: tool.usdPerCall ?? null,
      soloShare: tool.soloShare ?? null,
    })),
    // A session carries the project it ran under so the page can say where an
    // expensive session lives. The label is the user's own local name for that
    // project, never a path — an unlabelled id stays a bare fingerprint.
    sessions: report.topSessions.slice(0, 12).map((session) => ({
      id: session.id,
      project: session.project || null,
      label: (session.project && labels[session.project]) || null,
      usd: session.usd,
      outputUsd: session.outputUsd || 0,
      usdByClass: usdByClassOf(session.usdByClass),
      usage: usageOf(session.usage),
      requests: session.requests,
      avgPromptTokens: session.avgPromptTokens || 0,
    })),
    projects: (report.topProjects || []).slice(0, 12).map((project) => ({
      id: project.id,
      label: labels[project.id] || null,
      usd: project.usd,
      outputUsd: project.outputUsd || 0,
      usdByClass: usdByClassOf(project.usdByClass),
      usage: usageOf(project.usage),
      requests: project.requests,
    })),
    // `estimatedSavingsUsd` is the order this list already arrives in. Absent on
    // an analysis built before it existed, where it falls back to null and the
    // row simply prints no figure rather than a zero it cannot support.
    recommendations: analysis.recommendations.map(({ severity, kind, evidence, action, estimatedSavingsUsd }) => ({ severity, kind, evidence, action, estimatedSavingsUsd: estimatedSavingsUsd ?? null })),
    // The headline the ranked list adds up to, promoted to a reading: it is the
    // one number on this page that is a decision rather than a description.
    savings: savingsOf(analysis),
    // Aggregate deltas only: window dates, names, and dollars.
    changed: changedOf(trend, labels),
  };
}

// The mark, kept inline so the page stays a single response with no second
// route and no file read at runtime. Source of truth for the artwork is
// assets/favicon-ledger.svg; assets/mark.html previews it at real sizes.
// The SVG namespace is the one URL allowed in src/ — it is a namespace name
// that no browser resolves, and an XML-parsed data URI cannot omit it.
const MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="96" ry="96" fill="#1b1b1a"/><rect x="104" y="366" width="304" height="24" fill="#e9e5dc" fill-opacity=".45"/><g fill="#e9e5dc"><rect x="104" y="270" width="80" height="96"/><rect x="216" y="122" width="80" height="244"/><rect x="328" y="206" width="80" height="160"/></g></svg>`;
// encodeURIComponent leaves single quotes alone and escapes the rest, so the
// result is safe inside a double-quoted attribute and needs no hand-tuning.
const MARK_HREF = `data:image/svg+xml,${encodeURIComponent(MARK_SVG)}`;

function embeddedJson(value) {
  // Prevent a provider-controlled model or tool name from breaking out of the
  // inert data script. The browser only ever receives aggregate metadata.
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

/**
 * `labels` are the local project names from `agent-finops label`. They are
 * user-authored and hold no path, so they are safe on the loopback page — but
 * they are still text from a file, so they travel through `embeddedJson` and
 * are written with `textContent` like every other value here.
 *
 * `trend` is an optional `analyzeTrend` result. Only its per-key deltas reach
 * the page, through `changedOf`; a caller without one renders the same page with
 * the "what changed" section in its empty state.
 */
export function renderDashboard(report, analysis, labels = {}, trend = null) {
  const data = embeddedJson(dashboardPayload(report, analysis, labels || {}, trend));
  // Instrument Serif and DM Mono cannot be loaded from Google Fonts here: the
  // page ships under default-src 'none' and the privacy audit forbids any URL
  // in src/. The stacks below use them when installed locally and fall back to
  // the closest high-contrast serif otherwise.
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#1b1b1a">
  <title>Agent FinOps</title>
  <link rel="icon" href="${MARK_HREF}" type="image/svg+xml">
  <style>
    :root {
      color-scheme: dark;
      --ground:#1b1b1a; --ink:#e9e5dc; --muted:#aaa69e;
      --line:rgba(233,229,220,.22); --line-hi:rgba(233,229,220,.62);
      /* The one hue. It is an event, never a state: it arrives on hover or
         focus as a warmed hairline and leaves again. */
      --attn:rgba(198,172,110,.72);
      /* Token classes are steps of ink, not hues, so the page stays monochrome
         at rest. Cheapest class is dimmest, most expensive is brightest. */
      --cache-read:rgba(233,229,220,.22); --input:rgba(233,229,220,.44);
      --cache-write:rgba(233,229,220,.68); --output:rgba(233,229,220,.96);
      --unknown:rgba(233,229,220,.34);
      --serif:"Instrument Serif","Bodoni 72",Didot,"Hoefler Text",Baskerville,Georgia,serif;
      --mono:"DM Mono",ui-monospace,"SF Mono",Menlo,"Cascadia Mono","DejaVu Sans Mono",Consolas,monospace;
      --ease:cubic-bezier(.16,1,.3,1);
      --strip-h:180px;
      --cols:34px minmax(90px,1.15fr) minmax(80px,2fr) 92px 66px;
    }
    * { box-sizing:border-box; }
    html { background:var(--ground); }
    body {
      margin:0; background:var(--ground); color:var(--ink);
      font:13px/1.45 var(--mono); font-weight:400;
      font-variant-numeric:tabular-nums;
      padding:0 clamp(18px,4vw,56px) calc(64px + env(safe-area-inset-bottom));
    }
    /* The whole decorative vocabulary: one faint fixed grain. */
    .grain {
      position:fixed; inset:0; z-index:9; pointer-events:none; opacity:.014;
      background-image:
        repeating-linear-gradient(0deg,var(--ink) 0 1px,transparent 1px 4px),
        repeating-linear-gradient(90deg,var(--ink) 0 1px,transparent 1px 4px);
    }
    .sheet { max-width:1120px; margin:0 auto; }

    /* Two voices with nothing in between: display serif, and micro mono. */
    .serif { font-family:var(--serif); font-weight:400; margin:0; }
    .wordmark { font-size:clamp(32px,4vw,54px); line-height:.82; letter-spacing:-.06em; }
    .hero { font-size:clamp(54px,8.6vw,104px); line-height:.75; letter-spacing:-.075em; margin:16px 0 14px; }
    .reading { font-size:clamp(30px,3.4vw,46px); line-height:.9; letter-spacing:-.05em; margin:12px 0 10px; }
    .micro { margin:0; font-size:9.5px; line-height:1.6; text-transform:uppercase; letter-spacing:.085em; color:var(--muted); }
    p { margin:0; }

    header { display:flex; align-items:flex-start; justify-content:space-between; gap:24px; padding:clamp(40px,6vw,72px) 0 clamp(24px,3vw,36px); }
    header .scope { margin-top:16px; }
    .seal { flex:none; text-align:right; }
    .stale { color:var(--ink); }

    /* Sections divide with a rule and announce themselves in the label voice. */
    section { border-top:1px solid var(--line); padding:clamp(26px,3.2vw,40px) 0; }
    .section-head { display:flex; align-items:baseline; justify-content:space-between; gap:18px; }

    /* Register strip */
    .strip { position:relative; height:var(--strip-h); margin-top:clamp(20px,2.6vw,32px); }
    .grads { position:absolute; inset:0; display:flex; flex-direction:column; justify-content:space-between; pointer-events:none; }
    .grads i { display:block; border-top:1px dashed rgba(233,229,220,.12); }
    .grads i:last-child { border-top:1px solid var(--line); border-top-style:solid; }
    .ribbon { position:relative; display:flex; align-items:flex-end; gap:3px; height:100%; }
    .ribbon:focus-visible { outline:1px solid var(--attn); outline-offset:6px; }
    .seg { flex:1 1 0; max-width:74px; min-width:2px; min-height:1px; display:flex; flex-direction:column-reverse; cursor:crosshair; }
    .seg span { display:block; width:100%; }
    .needle { position:absolute; top:0; bottom:0; width:1px; background:var(--attn); opacity:0; pointer-events:none; transform:translateX(-1px); transition:transform 400ms var(--ease),opacity 400ms var(--ease); }
    .needle.on { opacity:1; }
    .axis { display:flex; justify-content:space-between; gap:16px; margin-top:10px; }
    .readout { margin-top:clamp(18px,2.2vw,26px); color:var(--ink); min-height:19px; }
    .legend { list-style:none; display:flex; flex-wrap:wrap; gap:6px 24px; margin:14px 0 0; padding:0; }
    .legend li { display:flex; align-items:center; gap:8px; font-size:9.5px; text-transform:uppercase; letter-spacing:.085em; color:var(--muted); }
    .legend i { width:15px; height:5px; flex:none; font-style:normal; }
    .legend b { color:var(--ink); font-weight:400; letter-spacing:.04em; }

    /* Readings */
    .readings { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:0 clamp(14px,2vw,28px); margin-top:clamp(18px,2.2vw,26px); align-items:start; }

    /* Dense data: micro-label column heads, hairline rows, no fills. */
    .thead, .row { display:grid; grid-template-columns:var(--cols); align-items:center; gap:clamp(10px,1.6vw,20px); }
    .thead { padding:0 0 10px; border-bottom:1px solid var(--line); margin-top:clamp(18px,2.2vw,26px); }
    body.no-kind .thead, body.no-kind .row { grid-template-columns:34px minmax(90px,1.15fr) minmax(80px,2fr) 92px; }
    body.no-kind .th-kind, body.no-kind .row-kind { display:none; }
    .num { text-align:right; }
    .row { width:100%; text-align:left; background:none; border:0; border-bottom:1px solid var(--line); color:inherit; font:inherit; padding:clamp(12px,1.4vw,17px) 0; cursor:pointer; transition:border-color 400ms var(--ease),transform 400ms var(--ease); }
    .row-index { font-size:9.5px; letter-spacing:.085em; color:var(--muted); transition:color 400ms var(--ease); }
    .row-kind { font-size:9.5px; text-transform:uppercase; letter-spacing:.085em; color:var(--muted); text-align:right; transition:color 400ms var(--ease); }
    .row-label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--ink); transition:transform 400ms var(--ease); }
    .row-value { text-align:right; color:var(--ink); opacity:.72; transition:opacity 400ms var(--ease); }
    .bar { display:flex; height:6px; transform:scaleX(0); transform-origin:left center; transition:transform 650ms var(--ease); }
    .bar span { display:block; }
    .row:focus-visible { outline:0; }
    .row:hover, .row:focus-visible { border-bottom-color:var(--attn); }
    .row:hover .row-value, .row:focus-visible .row-value { opacity:1; }
    .row:hover .row-index, .row:focus-visible .row-index, .row:hover .row-kind, .row:focus-visible .row-kind { color:var(--ink); }
    .row[aria-current="true"] { border-bottom-color:var(--line-hi); }
    .row[aria-current="true"] .row-index { color:var(--ink); }
    @media (hover:hover) and (pointer:fine) {
      .row:hover, .row:focus-visible { transform:translateX(clamp(6px,1.2vw,16px)); }
      .row:hover .row-label, .row:focus-visible .row-label { transform:translateX(4px); }
    }
    .detail { margin-top:clamp(14px,1.8vw,22px); color:var(--muted); white-space:pre-line; min-height:57px; }
    .empty { padding:16px 0; color:var(--muted); }

    /* A real control: hairline target, no fill at rest, hue only on focus. */
    /* No rectangles at rest: the hit target is padding, the border only shows
       up on interaction, and the selected mode reads as ink plus a rule. */
    .switcher { display:flex; gap:4px; flex:none; }
    .switcher button { background:none; border:1px solid transparent; border-radius:1px; padding:5px 10px 4px; cursor:pointer; font:inherit; font-size:9.5px; text-transform:uppercase; letter-spacing:.085em; color:var(--muted); box-shadow:inset 0 -1px 0 transparent; transition:color 400ms var(--ease),border-color 400ms var(--ease),box-shadow 400ms var(--ease); }
    .switcher button:hover { color:var(--ink); border-color:var(--line); }
    .switcher button[aria-pressed="true"] { color:var(--ink); box-shadow:inset 0 -1px 0 var(--line-hi); }
    .switcher button:focus-visible { outline:0; border-color:var(--attn); color:var(--ink); }

    /* Signals: severity reads as ink brightness, not colour. */
    .note { display:grid; grid-template-columns:34px minmax(0,1fr) 76px; align-items:baseline; gap:clamp(10px,1.6vw,20px); border-bottom:1px solid var(--line); padding:clamp(12px,1.4vw,17px) 0; transition:border-color 400ms var(--ease); }
    /* The section rule below already closes the stack; two would read double. */
    .note:last-child { border-bottom:0; }
    .note:hover { border-bottom-color:var(--attn); }
    .note-kind { color:var(--ink); margin-bottom:6px; }
    .note-evidence { color:var(--muted); }
    .note-action { color:var(--muted); opacity:.7; margin-top:7px; padding-left:15px; border-left:1px solid var(--line); transition:opacity 400ms var(--ease); }
    .note:hover .note-action { opacity:1; }
    /* The severity column also carries the estimated saving, which is what the
       list is ranked by: the figure in ink above the severity word. */
    .note-meter { text-align:right; }
    .note-savings { color:var(--ink); margin-bottom:5px; }
    .note-sev.high { color:var(--ink); }

    /* What changed: the signal row again, with direction carried by a sign and a
       step of ink. The page has one hue and it is reserved for interaction, so a
       rise and a fall must be legible with no colour at all. */
    .change { display:grid; grid-template-columns:64px minmax(0,1fr) 92px; align-items:baseline; gap:clamp(10px,1.6vw,20px); border-bottom:1px solid var(--line); padding:clamp(12px,1.4vw,17px) 0; }
    .change:last-child { border-bottom:0; }
    .change-name { color:var(--ink); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    /* A fall is the same ink, dimmed; a rise is at full strength. */
    .change-delta { text-align:right; color:var(--ink); opacity:.55; }
    .change-delta.up { opacity:1; }

    .colophon { display:grid; gap:14px; }
    .colophon .prose { max-width:68ch; color:var(--muted); opacity:.72; }

    @media (max-width:720px) {
      :root { --strip-h:130px; --cols:26px minmax(0,1fr) 88px; }
      header { display:block; padding-top:32px; }
      header .seal { text-align:left; margin-top:14px; }
      .readings { grid-template-columns:repeat(2,minmax(0,1fr)); gap:24px 18px; }
      /* Drop the decorative columns rather than crushing them. */
      .thead .th-mix, .thead .th-kind, .row .bar-cell, .row .row-kind { display:none; }
      .note { grid-template-columns:26px minmax(0,1fr); }
      /* The delta is the whole row here, so unlike .note-meter it stays. */
      .change { grid-template-columns:56px minmax(0,1fr) 78px; }
      .note-meter, .axis .axis-unit { display:none; }
      .section-head { display:block; }
      .switcher { margin-top:14px; }
    }
    @media (prefers-reduced-motion: reduce) {
      .bar { transform:none !important; }
      .needle, .row, .row-label, .row-value, .row-index, .row-kind, .note, .note-action, .switcher button, .bar { transition:none; }
      .row:hover, .row:focus-visible, .row:hover .row-label, .row:focus-visible .row-label { transform:none; }
    }
  </style>
</head>
<body>
  <div class="grain" aria-hidden="true"></div>
  <div class="sheet">
    <header>
      <div>
        <h1 class="serif wordmark">agent finops</h1>
        <p class="micro scope" id="scope"></p>
      </div>
      <p class="micro seal">loopback only / no uploads</p>
    </header>

    <section aria-label="Estimated cost over the reporting window">
      <p class="micro">estimated cost / usd</p>
      <p class="serif hero" id="cost">&mdash;</p>
      <p class="micro" id="requests"></p>
      <div class="strip">
        <div class="grads" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
        <div class="ribbon" id="ribbon" tabindex="0" role="img" aria-label="Daily estimated cost"></div>
        <div class="needle" id="needle"></div>
      </div>
      <div class="axis">
        <span class="micro" id="first-day"></span>
        <span class="micro axis-unit" id="strip-unit"></span>
        <span class="micro" id="last-day"></span>
      </div>
      <p class="readout" id="readout"></p>
      <ul class="legend" id="legend" aria-label="Token classes"></ul>
    </section>

    <section class="readings" aria-label="Rates and savings">
      <div><p class="micro">token volume</p><p class="serif reading" id="tokens">&mdash;</p><p class="micro">input + cache + output</p></div>
      <div><p class="micro">run rate</p><p class="serif reading" id="run-rate">&mdash;</p><p class="micro" id="run-rate-note">per active day</p></div>
      <div><p class="micro">identified savings</p><p class="serif reading" id="savings">&mdash;</p><p class="micro" id="savings-note">upper bound across ranked findings</p></div>
      <div><p class="micro">cost per turn</p><p class="serif reading" id="per-turn">&mdash;</p><p class="micro" id="per-turn-note">median billed turn</p></div>
    </section>

    <section id="changed-section" aria-label="Where spend moved against the previous window">
      <div class="section-head">
        <h2 class="micro">what changed / where the money moved, not why</h2>
        <p class="micro" id="changed-window"></p>
      </div>
      <div id="changed" style="margin-top:clamp(18px,2.2vw,26px)"></div>
    </section>

    <section aria-label="Cost breakdown">
      <div class="section-head">
        <h2 class="micro" id="rank-title">models by estimated cost</h2>
        <div class="switcher" role="group" aria-label="Cost breakdown">
          <button type="button" data-mode="models" aria-pressed="true">models</button>
          <button type="button" data-mode="tools" aria-pressed="false">tools &amp; mcps</button>
          <button type="button" data-mode="sessions" aria-pressed="false">sessions</button>
          <button type="button" data-mode="projects" aria-pressed="false">projects</button>
        </div>
      </div>
      <div class="thead" aria-hidden="true">
        <span class="micro num">#</span>
        <span class="micro">name</span>
        <span class="micro th-mix">cost by class</span>
        <span class="micro num">usd</span>
        <span class="micro th-kind num">kind</span>
      </div>
      <div id="ranking"></div>
      <p class="detail" id="detail">pick a row for its cost and token split</p>
    </section>

    <section aria-label="Where to investigate">
      <div class="section-head"><h2 class="micro">where to investigate / ranked by estimated savings</h2><p class="micro">upper bounds, not causation</p></div>
      <div id="recommendations" style="margin-top:clamp(18px,2.2vw,26px)"></div>
    </section>

    <section class="colophon">
      <p class="prose" id="colophon-text"></p>
      <p class="micro" id="colophon-notes"></p>
    </section>
  </div>
  <script>
    const DATA = ${data};
    // Token classes, for the counts in the row detail. Dimmest to brightest is
    // cheapest to most expensive per token, so the ink step is the rate card.
    const CLASSES = [
      { key:'cacheRead', label:'cache read', color:'var(--cache-read)' },
      { key:'input', label:'input', color:'var(--input)' },
      { key:'cacheCreate', label:'cache write', color:'var(--cache-write)' },
      { key:'output', label:'output', color:'var(--output)' },
    ];
    // The same four classes in dollars, which is what every bar on this page is
    // made of. Same order, same ink steps: a bar and the legend above it read as
    // one scale. The per-TTL cache-write rows are a breakdown of one segment and
    // deliberately never become a fifth.
    const COST_CLASSES = [
      { key:'cacheRead', label:'cache read', color:'var(--cache-read)' },
      { key:'input', label:'input', color:'var(--input)' },
      { key:'cacheWrite', label:'cache write', color:'var(--cache-write)' },
      { key:'output', label:'output', color:'var(--output)' },
    ];
    // Bar segments in dollars, or nothing when the row is unpriced and the
    // caller should draw its fallback instead.
    const costSplit = row => COST_CLASSES.map(cls => [cls.color,Math.max(0,(row.usdByClass || {})[cls.key] || 0)]);
    const dollars = new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2});
    const cents = new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:4});
    const whole = new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0});
    const integer = new Intl.NumberFormat('en-US',{maximumFractionDigits:0});
    const percent = value => value == null ? 'n/a' : (value * 100).toFixed(1) + '%';
    // Sub-cent turn costs are common; showing them as $0.00 would read as free.
    const money = value => value > 0 && value < 0.1 ? cents.format(value) : dollars.format(value);
    // A projection is stated at the precision it can support: whole dollars once
    // it is real money. Cents on an extrapolation claim an accuracy it lacks.
    const pace = value => value >= 100 ? whole.format(value) : money(value);
    // Per-unit money — $/call and $/turn — at 3 decimals under a dollar and 2
    // above: the same split the CLI's formatFineUsd uses, so the two surfaces
    // never disagree on what a call or a turn costs. Deliberately not money(),
    // whose four decimals are there to keep a sub-cent figure from reading as
    // free and turn a per-turn cost into $0.0902, which reads as noise.
    const fineMoney = value => '$' + value.toFixed(value < 1 ? 3 : 2);
    const tokenLabel = value => value >= 1e9 ? (value / 1e9).toFixed(2) + 'B' : value >= 1e6 ? (value / 1e6).toFixed(1) + 'M' : value >= 1e4 ? (value / 1e3).toFixed(0) + 'K' : integer.format(value);
    const classSum = usage => CLASSES.reduce((sum,item) => sum + (usage[item.key] || 0), 0);
    const count = (value,noun) => integer.format(value) + ' ' + noun + (value === 1 ? '' : 's');
    const ordinal = index => String(index + 1).padStart(2,'0');

    // The scope line is the tell for a stale or empty read, so it states what is
    // in the window, what the whole index holds, and when it was last scanned.
    // "1 usage records" alone looks like a quiet month rather than a bad index.
    const scanned = DATA.scannedAt ? new Date(DATA.scannedAt) : null;
    const scopeParts = [count(DATA.scope.recordsAfterDateFilter,'usage record') + ' in window'];
    if (Number.isFinite(DATA.scope.recordsRead) && DATA.scope.recordsRead !== DATA.scope.recordsAfterDateFilter) scopeParts.push(integer.format(DATA.scope.recordsRead) + ' indexed');
    scopeParts.push(scanned ? 'scanned ' + scanned.toLocaleString() : 'read ' + new Date(DATA.generatedAt).toLocaleString());
    const scopeLine = document.getElementById('scope');
    scopeLine.textContent = scopeParts.join(' / ');
    const staleMs = scanned ? new Date(DATA.generatedAt) - scanned : 0;
    if (staleMs > 3600000) {
      const warn = document.createElement('span');
      warn.className = 'stale';
      warn.textContent = ' / index is ' + Math.round(staleMs / 3600000) + 'h old, rerun with --fresh';
      scopeLine.append(warn);
    }
    document.getElementById('cost').textContent = dollars.format(DATA.total.usd);
    // Direction is the first thing anyone wants from a spend figure. Comparing
    // equal halves of the window keeps it descriptive and avoids a part-day tail
    // skewing the recent side.
    function trendLine(days) {
      if (days.length < 4) return null;
      const half = Math.floor(days.length / 2);
      const prior = days.slice(days.length - half * 2, days.length - half).reduce((sum,day) => sum + day.usd,0);
      const recent = days.slice(days.length - half).reduce((sum,day) => sum + day.usd,0);
      if (prior <= 0) return null;
      const change = (recent - prior) / prior;
      if (Math.abs(change) < 0.01) return 'level against the previous ' + count(half,'day');
      return (change > 0 ? 'up ' : 'down ') + Math.abs(change * 100).toFixed(0) + '% on the previous ' + count(half,'day');
    }
    const trend = trendLine(DATA.byDay);
    const headline = [count(DATA.total.requests,'billed turn'), count(DATA.byDay.length,'day') + ' shown'];
    if (trend) headline.push(trend);
    // An unpriced model understates the headline, so it qualifies the figure
    // rather than sitting in the colophon.
    if (DATA.diagnostics.unpricedTokens) headline.push('partial, ' + tokenLabel(DATA.diagnostics.unpricedTokens) + ' tokens unpriced');
    document.getElementById('requests').textContent = headline.join(' / ');
    document.getElementById('tokens').textContent = tokenLabel(DATA.total.usage.total);
    // Spend per day is what a total means. The same figure is unremarkable over
    // a quarter and worth stopping for over a week, and only the rate says
    // which. The month beside it is this same workload extended at that pace —
    // never a forecast of the next one, and never a bill. Legacy and tag-shaped
    // payloads carry no rate, and read as a dash rather than an invented one.
    const runRate = DATA.insights.runRate;
    document.getElementById('run-rate').textContent = runRate ? money(runRate.usdPerDay) : '—';
    document.getElementById('run-rate-note').textContent = runRate
      ? 'per active day / ~' + pace(runRate.projectedMonthlyUsd) + ' per 30d at this pace'
      : 'no dated records in this window';
    // What the ranked findings below are worth if every one of them is acted on.
    // An upper bound across the findings that could be quantified, never a total
    // of the window: a window where nothing crossed a threshold says so.
    const savings = DATA.savings;
    const quantified = savings && savings.totalUsd > 0;
    document.getElementById('savings').textContent = quantified ? money(savings.totalUsd) : '—';
    document.getElementById('savings-note').textContent = quantified
      ? 'upper bound across ' + count(savings.quantifiedFindings,'ranked finding')
      : 'nothing quantified in this window';
    // The median is the turn this window actually looks like; a handful of huge
    // turns drags the mean well above it, so both are shown and the mean is the
    // one in the footnote. Older tag-shaped data has no distribution, so the
    // mean is recomputed rather than leaving the reading blank.
    const perTurn = DATA.insights.perTurnUsd;
    document.getElementById('per-turn').textContent = perTurn ? fineMoney(perTurn.p50)
      : DATA.total.requests ? fineMoney(DATA.total.usd / DATA.total.requests) : 'n/a';
    document.getElementById('per-turn-note').textContent = perTurn
      ? 'median billed turn / mean ' + fineMoney(perTurn.mean) + ' / p90 ' + fineMoney(perTurn.p90)
      : 'mean billed turn';
    // The legend names what the bars are actually made of, in the same unit as
    // the bars: dollars. Token counts are a different story and live in the row
    // detail, where they are labelled as tokens. The four entries are the four
    // segments, in the order they stack.
    const legend = document.getElementById('legend');
    for (const item of COST_CLASSES.map(cls => ({ label:cls.label, color:cls.color, usd:DATA.total.usdByClass[cls.key] || 0 }))) {
      const entry = document.createElement('li');
      const swatch = document.createElement('i'); swatch.style.background = item.color;
      const name = document.createElement('span'); name.textContent = item.label;
      const value = document.createElement('b'); value.textContent = money(item.usd);
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
      // Height and fill are both dollars, split by class. Filling a cost bar by
      // token mix made cache reads look like the cost driver when they are the
      // cheapest class; with nothing priced there are no dollars to split and
      // the same four classes are drawn in tokens, which the unit line says.
      const parts = metric === 'usd' ? costSplit(day) : CLASSES.map(cls => [cls.color,day.usage[cls.key] || 0]);
      const filled = parts.reduce((sum,[,value]) => sum + value,0);
      for (const [color,value] of (filled > 0 ? parts : [['var(--unknown)',1]])) {
        const block = document.createElement('span');
        block.style.flexGrow = String(value);
        block.style.background = color;
        seg.append(block);
      }
      segments.push(seg); ribbon.append(seg);
    }
    // The window summary holds the readout until someone reads a day, so no
    // colour is on screen at rest.
    const summary = days.length
      ? count(days.length,'day') + ' / ' + days[0].day + ' to ' + days.at(-1).day + (maxDay > 0 ? ' / peak ' + (metric === 'usd' ? money(maxDay) : tokenLabel(maxDay) + ' tokens') : '')
      : 'nothing to read in this window, widen it with --since';
    readout.textContent = summary;
    let active = -1;
    function readDay(index) {
      if (!days.length) return;
      active = Math.max(0,Math.min(days.length - 1,index));
      const seg = segments[active]; const day = days[active];
      needle.classList.add('on');
      needle.style.transform = 'translateX(' + (seg.offsetLeft + seg.offsetWidth / 2) + 'px)';
      const share = day.usd > 0 ? ' / output ' + percent(day.outputUsd / day.usd) + ' of cost' : '';
      readout.textContent = day.day + ' / ' + money(day.usd) + ' / ' + tokenLabel(day.usage.total) + ' tokens' + share;
    }
    function clearDay() { needle.classList.remove('on'); active = -1; readout.textContent = summary; }
    segments.forEach((seg,index) => seg.addEventListener('pointerenter',() => readDay(index)));
    ribbon.addEventListener('pointerleave',clearDay);
    ribbon.addEventListener('blur',clearDay);
    ribbon.addEventListener('keydown',(event) => {
      const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (!step) return;
      event.preventDefault();
      readDay(active < 0 ? days.length - 1 : active + step);
    });
    ribbon.setAttribute('aria-label',days.length ? 'Daily ' + (metric === 'usd' ? 'estimated cost' : 'token volume') + ' from ' + days[0].day + ' to ' + days.at(-1).day + '. Use arrow keys to read a day.' : 'No dated records in this window.');
    document.getElementById('strip-unit').textContent = !days.length ? 'no dated records' : metric === 'usd' ? 'daily cost by class' : 'daily tokens by class / no priced cost in this window';
    document.getElementById('first-day').textContent = days[0]?.day || '';
    document.getElementById('last-day').textContent = days.at(-1)?.day || '';

    // What moved between the two windows the trend compared. The headline says
    // spend rose; this says where it rose, which is the question that follows it.
    // Descriptive only — the heading says "not why" — and monochrome: direction
    // is a leading sign plus a step of ink, never a hue.
    const changed = DATA.changed;
    const changedRows = changed
      ? [...changed.byModel.map(row => ['model',row]), ...changed.byProject.map(row => ['project',row])]
      : [];
    const changedTarget = document.getElementById('changed');
    // U+2212, not a hyphen: it is the same width as the plus, so a column of
    // signed figures stays aligned in the tabular-nums voice around it.
    const signedMoney = value => (value < 0 ? '−' : '+') + money(Math.abs(value));
    if (changed) {
      document.getElementById('changed-window').textContent = 'last ' + count(changed.days,'day') + ' vs previous ' + changed.days;
      // The exact windows, for a reader who cannot see the layout.
      if (changed.current.start && changed.previous.start) {
        document.getElementById('changed-section').setAttribute('aria-label','Where spend moved: ' + changed.current.start + ' to ' + changed.current.end + ' against ' + changed.previous.start + ' to ' + changed.previous.end);
      }
    }
    for (const [kind,row] of changedRows) {
      const line = document.createElement('div'); line.className = 'change';
      const label = document.createElement('p'); label.className = 'micro'; label.textContent = kind;
      const name = document.createElement('p'); name.className = 'change-name'; name.textContent = row.name;
      const delta = document.createElement('p'); delta.className = 'change-delta' + (row.deltaUsd < 0 ? '' : ' up');
      delta.textContent = signedMoney(row.deltaUsd);
      line.append(label,name,delta); changedTarget.append(line);
    }
    if (!changedRows.length) {
      const empty = document.createElement('p'); empty.className = 'empty';
      // Two different silences: no second window to compare against at all, and
      // two windows where nothing moved. Neither is a reason to hide the section.
      empty.textContent = changed ? 'no model or project moved between these two windows' : 'not enough history to compare two windows';
      changedTarget.append(empty);
    }

    const recs = document.getElementById('recommendations');
    DATA.recommendations.forEach((rec,index) => {
      const note = document.createElement('div'); note.className = 'note';
      const number = document.createElement('p'); number.className = 'micro'; number.textContent = ordinal(index);
      const body = document.createElement('div');
      const kind = document.createElement('p'); kind.className = 'note-kind'; kind.textContent = rec.kind.replaceAll('-',' ');
      const evidence = document.createElement('p'); evidence.className = 'note-evidence'; evidence.textContent = rec.evidence;
      const action = document.createElement('p'); action.className = 'note-action'; action.textContent = rec.action;
      body.append(kind,evidence,action);
      // The saving is what the list is ordered by, so it sits above the severity
      // word in the same column and the same micro voice. A finding with no
      // defensible counterfactual prints the severity alone rather than a zero.
      const meter = document.createElement('div'); meter.className = 'note-meter';
      if (rec.estimatedSavingsUsd != null) { const savings = document.createElement('p'); savings.className = 'micro note-savings'; savings.textContent = money(rec.estimatedSavingsUsd); meter.append(savings); }
      const severity = document.createElement('p'); severity.className = 'micro note-sev ' + rec.severity; severity.textContent = rec.severity;
      meter.append(severity);
      note.append(number,body,meter); recs.append(note);
    });
    if (!DATA.recommendations.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = 'nothing crossed a hotspot threshold in this window'; recs.append(empty); }

    const labels = { models:'models by estimated cost', tools:'tool and mcp follow-on cohorts', sessions:'most expensive anonymous sessions', projects:'most expensive projects' };
    const kindOf = { models:() => 'model', tools:item => item.name.startsWith('mcp__') ? 'mcp' : 'tool', sessions:() => 'session', projects:() => 'project' };
    // A project id is a salted local fingerprint, so it is only a name once
    // someone gives it one. Shortened here because the row is about the session.
    const projectOf = item => item.label || (item.project ? item.project.slice(0,6) : 'unattributed');
    const detailText = {
      models:item => count(item.requests,'billed turn'),
      tools:item => {
        const perCall = item.usdPerCall == null ? 'n/a' : '≈' + fineMoney(item.usdPerCall) + '/call';
        const solo = item.soloShare == null ? 'solo n/a' : 'solo ' + Math.round(item.soloShare * 100) + '% of attributed cost';
        return count(item.calls,'call') + ' / ' + count(item.followOnRequests,'following billed turn') + ' / attribution is correlation / ' + perCall + ' / ' + solo;
      },
      sessions:item => count(item.requests,'billed turn') + ' / project: ' + projectOf(item) + ' / avg prompt ' + tokenLabel(item.avgPromptTokens || 0) + ' tokens/turn',
      projects:item => count(item.requests,'billed turn') + ' / ' + (item.label ? 'id ' + item.id + ' / rename' : 'name') + ' it locally with agent-finops label ' + item.id + ' "Name"',
    };
    function renderRanking(mode) {
      document.getElementById('rank-title').textContent = labels[mode];
      const target = document.getElementById('ranking'); target.replaceChildren();
      document.getElementById('detail').textContent = 'pick a row for its cost and token split';
      // "kind" only distinguishes anything in the tools view, where it separates
      // an MCP from a built-in tool. Elsewhere it repeats one word down a column.
      document.body.classList.toggle('no-kind',mode !== 'tools');
      const rows = DATA[mode]; const max = Math.max(0,...rows.map(row => row.usd));
      if (!rows.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = 'no rows in this window'; target.append(empty); return; }
      rows.forEach((item,index) => {
        // A session stays under its own fingerprint even though it carries a
        // project label; only a project row is named by the label.
        const rowName = mode === 'projects' ? (item.label || item.id) : (item.name || item.id);
        const row = document.createElement('button'); row.type = 'button'; row.className = 'row';
        row.setAttribute('aria-label',rowName + ', ' + dollars.format(item.usd));
        const number = document.createElement('span'); number.className = 'row-index num'; number.textContent = ordinal(index);
        const label = document.createElement('span'); label.className = 'row-label'; label.textContent = rowName;
        const cell = document.createElement('span'); cell.className = 'bar-cell';
        const bar = document.createElement('span'); bar.className = 'bar';
        bar.style.width = (max > 0 ? item.usd / max : 0) * 100 + '%';
        const total = classSum(item.usage);
        // One bar, one unit: length is this row's cost, split into the same four
        // cost classes the chart above uses. Token mix is in the row detail.
        const split = costSplit(item);
        const filled = split.reduce((sum,[,value]) => sum + value,0);
        for (const [color,value] of (filled > 0 ? split : [['var(--unknown)',1]])) {
          const block = document.createElement('span'); block.style.background = color; block.style.flexGrow = String(value); bar.append(block);
        }
        cell.append(bar);
        requestAnimationFrame(() => { bar.style.transform = 'scaleX(1)'; });
        const value = document.createElement('span'); value.className = 'row-value'; value.textContent = dollars.format(item.usd);
        const kind = document.createElement('span'); kind.className = 'row-kind'; kind.textContent = kindOf[mode](item);
        row.append(number,label,cell,value,kind);
        row.addEventListener('click',() => {
          for (const other of target.querySelectorAll('.row')) other.removeAttribute('aria-current');
          row.setAttribute('aria-current','true');
          const mix = total > 0 ? 'tokens: ' + CLASSES.map(cls => cls.label + ' ' + percent((item.usage[cls.key] || 0) / total)).join(' / ') : 'token classes not recorded';
          // Dollars and tokens rank differently, so the two lines are kept
          // side by side and each one names its own unit.
          const costLine = item.usd > 0
            ? 'cost: ' + COST_CLASSES.map(cls => cls.label + ' ' + money((item.usdByClass || {})[cls.key] || 0) + ' (' + percent(((item.usdByClass || {})[cls.key] || 0) / item.usd) + ')').join(' / ')
            : 'no priced cost';
          document.getElementById('detail').textContent = rowName + ' / ' + tokenLabel(item.usage.total) + ' tokens / ' + detailText[mode](item) + '\\n' + costLine + '\\n' + mix;
        });
        target.append(row);
      });
    }
    for (const button of document.querySelectorAll('[data-mode]')) button.addEventListener('click',() => { for (const other of document.querySelectorAll('[data-mode]')) other.setAttribute('aria-pressed','false'); button.setAttribute('aria-pressed','true'); renderRanking(button.dataset.mode); });
    renderRanking('models');

    document.getElementById('colophon-text').textContent = 'rendered from the private metadata index / no prompts, responses, arguments, tool results, source paths, or outbound calls are included / tool and mcp values allocate only the immediately following billed turn, so they show cohorts, not invoice lines';
    const notes = [];
    if (DATA.diagnostics.duplicatesDropped) notes.push(count(DATA.diagnostics.duplicatesDropped,'streaming duplicate') + ' collapsed');
    if (DATA.diagnostics.missingIds) notes.push(count(DATA.diagnostics.missingIds,'record') + ' kept without a full dedup key');
    if (DATA.diagnostics.unpricedTokens) notes.push(tokenLabel(DATA.diagnostics.unpricedTokens) + ' tokens from unpriced models');
    document.getElementById('colophon-notes').textContent = notes.length ? notes.join(' / ') : 'no accounting warnings';
  </script>
</body>
</html>`;
}

/**
 * Binding to loopback stops the LAN from reaching the page, but not a public
 * site that resolves its own name to 127.0.0.1: the browser would treat it as
 * same-origin and could read this page. Only serve a loopback Host.
 * Exported so the rebinding rule can be table-tested directly.
 */
export function isLoopbackHost(host, port) {
  if (typeof host !== "string") return false;
  const [name] = host.startsWith("[") ? [host.slice(0, host.indexOf("]") + 1)] : host.split(":");
  const requestedPort = host.slice(name.length).replace(/^:/, "");
  if (requestedPort && Number(requestedPort) !== port) return false;
  return name === LOOPBACK_HOST || name === "localhost" || name === "[::1]";
}

export async function startDashboard(report, analysis, { port = 7474, labels = {}, trend = null } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be an integer from 0 to 65535.");
  const page = renderDashboard(report, analysis, labels, trend);
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
      // img-src is data: only. Browsers check the favicon against it, and a
      // data URI cannot reach the network, so this stays a closed page.
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'",
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
