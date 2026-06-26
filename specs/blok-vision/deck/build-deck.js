// Builds a designed HTML deck (deck.html) from slides.json + static slides.
// Code is syntax-highlighted at build time (offline-robust). Render with render.js.
const fs = require("node:fs");
const path = require("node:path");
const hljs = require("highlight.js");

const HERE = __dirname;
const slides = JSON.parse(fs.readFileSync(path.join(HERE, "slides.json"), "utf8")).slides;
const byId = Object.fromEntries(slides.map((s) => [s.id, s]));

const LANG = {
	ts: "typescript",
	json: "json",
	bash: "bash",
	yaml: "yaml",
	text: null,
	tsx: "typescript",
	mermaid: null,
};
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function hl(code, lang) {
	const l = LANG[lang] ?? null;
	if (!l) return esc(code);
	try {
		return hljs.highlight(code, { language: l }).value;
	} catch {
		return esc(code);
	}
}

// ---- design tokens ----
const CSS = `
:root{
  --bg:#0A0C10; --bg2:#0E1117; --panel:#12161D; --panel2:#161B23;
  --border:#222A35; --border2:#2C3644;
  --text:#EAEEF5; --muted:#9AA6B5; --faint:#6B7686;
  --blue:#5C9DFF; --teal:#3FD9A6; --amber:#F5BE5B;
  --red:#FF7A7A; --green:#43D9A3;
  --mono:"SF Mono","JetBrains Mono",ui-monospace,Menlo,Consolas,monospace;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:var(--bg);color:var(--text);font-family:var(--sans);-webkit-font-smoothing:antialiased}
@page{size:1280px 720px;margin:0}
.slide{width:1280px;height:720px;position:relative;overflow:hidden;background:var(--bg);
  page-break-after:always;padding:60px 72px;display:flex;flex-direction:column}
.slide:last-child{page-break-after:auto}
.slide::after{content:"";position:absolute;inset:0;pointer-events:none;
  background:radial-gradient(1200px 500px at 100% -10%, rgba(92,157,255,.06), transparent 60%)}
.eyebrow{display:flex;align-items:center;gap:12px;font-size:15px;color:var(--muted);letter-spacing:.06em;text-transform:uppercase;font-weight:500}
.chip{display:inline-flex;align-items:center;gap:7px;font-size:13px;padding:4px 11px;border-radius:999px;border:1px solid var(--border2);color:var(--muted);background:var(--panel)}
.dot{width:8px;height:8px;border-radius:999px;background:var(--blue)}
h1.title{font-size:96px;font-weight:600;letter-spacing:-.03em;line-height:1;
  background:linear-gradient(110deg,#fff 10%,var(--blue) 55%,var(--teal));-webkit-background-clip:text;background-clip:text;color:transparent}
h2.head{font-size:46px;font-weight:600;letter-spacing:-.02em;line-height:1.05;margin-top:18px}
h2.head .lead{color:var(--blue)}
.sub{font-size:23px;color:var(--muted);font-weight:400;line-height:1.4;margin-top:16px;max-width:980px}
.foot{position:absolute;left:72px;right:72px;bottom:34px;display:flex;justify-content:space-between;align-items:center;
  font-size:14px;color:var(--faint);border-top:1px solid var(--border);padding-top:14px}
.foot b{color:var(--muted);font-weight:500}
/* before/after */
.headline{font-size:34px;font-weight:600;letter-spacing:-.01em;line-height:1.12;margin:6px 0 4px;max-width:1080px}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:22px;margin-top:22px;flex:1;min-height:0}
.pane{display:flex;flex-direction:column;border:1px solid var(--border);border-radius:14px;background:var(--panel);overflow:hidden;min-height:0}
.pane .ph{display:flex;align-items:center;gap:10px;padding:13px 18px;border-bottom:1px solid var(--border);font-size:15px}
.pane .ph .tag{font-weight:600;letter-spacing:.02em}
.pane.before .ph{background:linear-gradient(90deg,rgba(255,122,122,.10),transparent)}
.pane.before .ph .d{width:9px;height:9px;border-radius:999px;background:var(--red)}
.pane.before .ph .tag{color:var(--red)}
.pane.after .ph{background:linear-gradient(90deg,rgba(67,217,163,.12),transparent)}
.pane.after .ph .d{width:9px;height:9px;border-radius:999px;background:var(--green)}
.pane.after .ph .tag{color:var(--green)}
.pane .cap{margin-left:auto;font-size:13px;color:var(--muted);font-weight:400}
.pane pre{flex:1;margin:0;padding:18px 20px;overflow:hidden;background:var(--bg2)}
.pane code{font-family:var(--mono);font-size:15.5px;line-height:1.62;white-space:pre;color:#cdd6e3}
.why{margin-top:20px;display:flex;align-items:center;gap:16px;padding:16px 22px;border:1px solid var(--border);
  border-left:3px solid var(--teal);border-radius:12px;background:var(--panel2)}
.why .arr{color:var(--teal);font-size:22px;font-weight:700}
.why .txt{font-size:19px;color:var(--text);line-height:1.35}
.why .txt b{color:var(--teal);font-weight:600}
/* phase divider */
.divider{justify-content:center}
.divider .pnum{font-size:160px;font-weight:700;line-height:1;color:transparent;-webkit-text-stroke:2px var(--border2)}
.divider h2{font-size:62px;font-weight:600;letter-spacing:-.02em;margin-top:6px}
.divider .d-sub{font-size:24px;color:var(--muted);margin-top:14px;max-width:900px;line-height:1.4}
.divider .specs{display:flex;gap:10px;margin-top:30px;flex-wrap:wrap}
/* map / grid */
.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;margin-top:30px;flex:1}
.gcol{border:1px solid var(--border);border-radius:14px;background:var(--panel);padding:22px;display:flex;flex-direction:column}
.gcol h3{font-size:17px;color:var(--blue);letter-spacing:.04em;text-transform:uppercase;font-weight:600;margin-bottom:6px}
.gcol .pz{font-size:13px;color:var(--faint);margin-bottom:14px}
.item{display:flex;gap:12px;padding:11px 0;border-top:1px solid var(--border)}
.item .ic{width:30px;height:30px;flex:none;border-radius:8px;background:var(--panel2);border:1px solid var(--border2);display:flex;align-items:center;justify-content:center;color:var(--blue);font-size:16px}
.item .t{font-size:16px;font-weight:600}
.item .s{font-size:13.5px;color:var(--muted);line-height:1.3;margin-top:2px}
/* pillars */
.pillars{display:grid;grid-template-columns:repeat(4,1fr);gap:18px;margin-top:36px}
.pill{border:1px solid var(--border);border-radius:14px;background:var(--panel);padding:22px}
.pill .pi{font-size:26px;color:var(--teal);margin-bottom:12px}
.pill .pt{font-size:18px;font-weight:600;margin-bottom:6px}
.pill .ps{font-size:14px;color:var(--muted);line-height:1.4}
/* table */
table.cmp{width:100%;border-collapse:collapse;margin-top:26px;font-size:16px}
table.cmp th,table.cmp td{text-align:left;padding:13px 16px;border-bottom:1px solid var(--border);vertical-align:top}
table.cmp thead th{font-size:14px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;border-bottom:1px solid var(--border2)}
table.cmp th.blok,table.cmp td.blok{background:linear-gradient(180deg,rgba(63,217,166,.08),transparent)}
table.cmp th.blok{color:var(--teal)}
table.cmp td.row{color:var(--muted);font-weight:500}
table.cmp td b{color:var(--text);font-weight:600}
.muted-cell{color:var(--faint)}
/* decisions */
.two{display:grid;grid-template-columns:1.1fr 1fr;gap:26px;margin-top:26px;flex:1}
.dbox{border:1px solid var(--border);border-radius:14px;background:var(--panel);padding:24px}
.dbox h3{font-size:16px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:16px}
.drow{display:flex;gap:12px;padding:10px 0;border-top:1px solid var(--border);font-size:15px}
.drow:first-of-type{border-top:none}
.drow .k{color:var(--blue);font-weight:600;font-family:var(--mono);font-size:13px;min-width:30px}
.drow .v{color:var(--text);line-height:1.35}
.drow .v .c{color:var(--muted)}
.decide{display:flex;gap:14px;padding:14px 0;border-top:1px solid var(--border)}
.decide .n{width:26px;height:26px;flex:none;border-radius:999px;background:var(--blue);color:#04101f;font-weight:700;display:flex;align-items:center;justify-content:center;font-size:14px}
.decide .dt{font-size:17px;font-weight:600}
.decide .dd{font-size:14px;color:var(--muted);line-height:1.35;margin-top:2px}
.center{align-items:center;justify-content:center;text-align:center}
.big-quote{font-size:40px;font-weight:600;letter-spacing:-.02em;line-height:1.2;max-width:1040px}
.big-quote .hl{color:var(--teal)}
`;

// hljs theme (inlined, tuned to the panel bg)
let THEME = "";
try {
	THEME = fs.readFileSync(require.resolve("highlight.js/styles/github-dark.css"), "utf8");
} catch {}
THEME +=
	"\n.hljs{background:transparent;color:#cdd6e3}\n.hljs-comment,.hljs-quote{color:#6b7686;font-style:italic}\n.hljs-keyword,.hljs-selector-tag{color:#7aa2ff}\n.hljs-string,.hljs-attr{color:#5fd0a6}\n.hljs-number,.hljs-literal{color:#e0a458}\n.hljs-title,.hljs-name,.hljs-function .hljs-title{color:#8fd3ff}\n.hljs-built_in,.hljs-type{color:#9bb4ff}\n.hljs-meta{color:#9aa6b5}\n";

const ICON = (name) => `<i class="ti ti-${name}"></i>`;

// ---- spec slide ----
function specSlide(s) {
	const phaseName = { 1: "Foundation", 2: "Studio · Registry · Triggers", 3: "Marketplace · AI · Distribution" }[
		s.phase
	];
	return `<section class="slide">
    <div class="eyebrow"><span class="chip">${ICON(s.icon)} ${s.id}</span> Phase ${s.phase} · ${phaseName} <span class="chip" style="margin-left:auto">${esc(s.compat)}</span></div>
    <div class="headline">${esc(s.headline)}</div>
    <div class="cols">
      <div class="pane before">
        <div class="ph"><span class="d"></span><span class="tag">${esc(s.beforeLabel)}</span><span class="cap">${esc(s.beforeCaption)}</span></div>
        <pre><code class="hljs">${hl(s.beforeCode, s.lang)}</code></pre>
      </div>
      <div class="pane after">
        <div class="ph"><span class="d"></span><span class="tag">${esc(s.afterLabel)}</span><span class="cap">${esc(s.afterCaption)}</span></div>
        <pre><code class="hljs">${hl(s.afterCode, s.lang)}</code></pre>
      </div>
    </div>
    <div class="why"><span class="arr">→</span><span class="txt"><b>Why.</b> ${esc(s.why)}</span></div>
    <div class="foot"><b>${esc(s.title)}</b><span>Blok Platform Vision &nbsp;·&nbsp; ${s.id}</span></div>
  </section>`;
}

// ---- static slides ----
const phaseSpecs = (p) => slides.filter((s) => s.phase === p);
const specChips = (p) =>
	phaseSpecs(p)
		.map((s) => `<span class="chip">${ICON(s.icon)} ${s.id} ${esc(s.title)}</span>`)
		.join("");

function divider(p, title, sub) {
	return `<section class="slide divider center">
    <div class="pnum">0${p}</div>
    <h2>Phase ${p} — ${title}</h2>
    <div class="d-sub">${sub}</div>
    <div class="specs">${specChips(p)}</div>
    <div class="foot"><b>Blok Platform Vision</b><span>Phase ${p} of 3</span></div>
  </section>`;
}

function mapItem(s) {
	return `<div class="item"><div class="ic">${ICON(s.icon)}</div><div><div class="t">${s.id} · ${esc(s.title)}</div><div class="s">${esc(s.headline)}</div></div></div>`;
}

const cover = `<section class="slide center">
  <div style="position:absolute;top:60px;left:72px" class="eyebrow"><span class="dot"></span> Platform Vision · 2026</div>
  <h1 class="title">Blok</h1>
  <h2 class="head" style="margin-top:24px">The <span class="lead">AI-native</span> modular workflow platform</h2>
  <div class="sub" style="text-align:center">12 changes across 3 phases — turning Blok into the only platform that is code-first <i>and</i> visual <i>and</i> multi-runtime <i>and</i> AI-native.</div>
  <div class="foot"><b>Founder briefing</b><span>specs/blok-vision &nbsp;·&nbsp; before → after</span></div>
</section>`;

const bet = `<section class="slide">
  <div class="eyebrow"><span class="dot"></span> The bet</div>
  <h2 class="head" style="max-width:1080px">An AI assembles a production backend in a day —<br>and a human opens the <span class="lead">same workflow</span> on a visual canvas.</h2>
  <div class="pillars">
    <div class="pill"><div class="pi">${ICON("code")}</div><div class="pt">Code-first</div><div class="ps">Typed, diffable, PR-reviewable workflows — like Trigger.dev.</div></div>
    <div class="pill"><div class="pi">${ICON("topology-star-3")}</div><div class="pt">Visual</div><div class="ps">Connect-by-clicking on a canvas — like n8n, but never fragile.</div></div>
    <div class="pill"><div class="pi">${ICON("stack-2")}</div><div class="pt">Multi-runtime</div><div class="ps">Nodes in 8 languages — like Windmill, but the good parts stay free.</div></div>
    <div class="pill"><div class="pi">${ICON("robot")}</div><div class="pt">AI-native</div><div class="ps">MCP + Skills over one CLI kernel. Every rival bolted AI on after.</div></div>
  </div>
  <div class="foot"><b>North star</b><span>The canonical TS workflow stays the source of truth; one JSON IR feeds canvas, registry & AI</span></div>
</section>`;

const mapSlide = `<section class="slide">
  <div class="eyebrow"><span class="dot"></span> The 12 changes</div>
  <h2 class="head" style="font-size:40px">Every change, grouped by phase</h2>
  <div class="grid3">
    <div class="gcol"><h3>Phase 1 · Foundation</h3><div class="pz">The forks everything builds on</div>${phaseSpecs(1).map(mapItem).join("")}</div>
    <div class="gcol"><h3>Phase 2 · Studio · Registry</h3><div class="pz">Blok becomes editable & installable</div>${phaseSpecs(2).map(mapItem).join("")}</div>
    <div class="gcol"><h3>Phase 3 · Marketplace · AI</h3><div class="pz">The moat</div>${phaseSpecs(3).map(mapItem).join("")}</div>
  </div>
  <div class="foot"><b>Blok Platform Vision</b><span>12 specs · S1–S12</span></div>
</section>`;

const roadmap = `<section class="slide">
  <div class="eyebrow"><span class="dot"></span> Roadmap</div>
  <h2 class="head" style="font-size:40px">Smallest-shippable-first — each phase ends on a real demo</h2>
  <div class="grid3">
    <div class="gcol"><h3>Phase 1 · Foundation</h3><div class="pz">S1 IR · S2 identity · S3 expressions · S7 descriptor</div>
      <div class="item"><div class="ic">${ICON("flask")}</div><div><div class="t">Demo</div><div class="s">A workflow validates against the published schema; the branch <code>when</code> bug fails at author-time, not as a silent 500.</div></div></div></div>
    <div class="gcol"><h3>Phase 2 · Studio · Registry</h3><div class="pz">S4 edit · S5 UX · S6 registry · S8 triggers</div>
      <div class="item"><div class="ic">${ICON("flask")}</div><div><div class="t">Demo</div><div class="s">Drag from an output → filtered palette → wire by clicking → run one step → publish a node. Zero hand-typed expressions.</div></div></div></div>
    <div class="gcol"><h3>Phase 3 · Marketplace · AI</h3><div class="pz">S9 packaging · S10 connections · S11 MCP · S12 trust</div>
      <div class="item"><div class="ic">${ICON("flask")}</div><div><div class="t">Demo</div><div class="s">An AI searches the registry, installs a Verified node by hash, wires a managed connection, runs tests green — all via MCP.</div></div></div></div>
  </div>
  <div class="foot"><b>Blok Platform Vision</b><span>Hybrid change appetite — new surfaces bold, existing workflows backward-compatible</span></div>
</section>`;

const positioning = `<section class="slide">
  <div class="eyebrow"><span class="dot"></span> Positioning</div>
  <h2 class="head" style="font-size:38px">How Blok beats n8n, Trigger.dev & Windmill</h2>
  <table class="cmp">
    <thead><tr><th>Capability</th><th>n8n</th><th>Trigger.dev</th><th>Windmill</th><th class="blok">Blok</th></tr></thead>
    <tbody>
      <tr><td class="row">Code ↔ visual</td><td class="muted-cell">Visual only, fragile</td><td class="muted-cell">Code only</td><td class="muted-cell">Visual + projections</td><td class="blok"><b>Both, losslessly</b></td></tr>
      <tr><td class="row">Authoring ergonomics</td><td class="muted-cell">Drag palette</td><td class="muted-cell">Plain TS</td><td class="muted-cell">Connect-picker</td><td class="blok"><b>Both wins, one surface</b></td></tr>
      <tr><td class="row">Multi-runtime</td><td class="muted-cell">Node only</td><td class="muted-cell">Node only</td><td class="muted-cell">Multi, gated triggers</td><td class="blok"><b>Multi + free triggers</b></td></tr>
      <tr><td class="row">AI-native</td><td class="muted-cell">None</td><td class="muted-cell">NL over runs</td><td class="muted-cell">Flow-builder chat</td><td class="blok"><b>MCP + Skills kernel</b></td></tr>
      <tr><td class="row">Marketplace + auth</td><td class="muted-cell">Two registries</td><td class="muted-cell">"any npm pkg"</td><td class="muted-cell">Hub + badge</td><td class="blok"><b>npm-protocol + managed auth</b></td></tr>
      <tr><td class="row">Trust posture</td><td class="muted-cell">Relicensed</td><td class="muted-cell">—</td><td class="muted-cell">Paywalled core</td><td class="blok"><b>License set up front</b></td></tr>
    </tbody>
  </table>
  <div class="foot"><b>Blok Platform Vision</b><span>Code-first AND visual AND multi-runtime AND AI-native — on one CLI kernel</span></div>
</section>`;

const dchip = (k, v) => `<div class="drow"><span class="k">${k}</span><span class="v">${v}</span></div>`;
const decisions = `<section class="slide">
  <div class="eyebrow"><span class="dot"></span> Decisions</div>
  <h2 class="head" style="font-size:38px">Eight architecture calls — and three that are yours</h2>
  <div class="two">
    <div class="dbox"><h3>Cross-cutting decisions (D1–D8)</h3>
      ${dchip("D1", 'TS canonical + <span class="c">published JSON IR</span>')}
      ${dchip("D2", 'Canvas positions ephemeral; <span class="c">optional ui pass-through</span>')}
      ${dchip("D3", '<span class="c">npm-protocol-compatible</span> registry')}
      ${dchip("D4", 'Mandatory scopes + <span class="c">version-pinned refs</span>')}
      ${dchip("D5", 'Keep $ proxy; <span class="c">fix the when footgun</span>')}
      ${dchip("D6", 'One module descriptor for <span class="c">triggers/nodes/runtimes</span>')}
      ${dchip("D7", 'blokctl is the <span class="c">single kernel</span>')}
      ${dchip("D8", 'Multi-runtime = <span class="c">N impls, one entry</span>')}
    </div>
    <div class="dbox"><h3>What only you can decide</h3>
      <div class="decide"><span class="n">1</span><div><div class="dt">License &amp; commercial model</div><div class="dd">Open-core or permissive + paid trust tier — not the relicense move that cost n8n &amp; Windmill their community.</div></div></div>
      <div class="decide"><span class="n">2</span><div><div class="dt">Build vs. extend the registry</div><div class="dd">Build the thin in-house registry — it gates the whole Phase-3 marketplace.</div></div></div>
      <div class="decide"><span class="n">3</span><div><div class="dt">Accept the multi-runtime split</div><div class="dd">"One node, all runtimes" → "one marketplace entry, N implementations." Turns multi-runtime into a sandboxing edge.</div></div></div>
    </div>
  </div>
  <div class="foot"><b>Blok Platform Vision</b><span>Full rationale in specs/blok-vision/S0-master-vision.md</span></div>
</section>`;

const closing = `<section class="slide center">
  <div class="eyebrow" style="position:absolute;top:60px;left:72px"><span class="dot"></span> Where to start</div>
  <div class="big-quote">Ship <span class="hl">S3</span> now — it fixes a live bug, zero infra.<br>Prototype the <span class="hl">canvas</span>. Pick the <span class="hl">license</span>.</div>
  <div class="sub" style="text-align:center;margin-top:28px">n8n is visual-but-fragile · Trigger.dev is code-but-not-visual · Windmill gates the good parts.<br>Blok is the only one that's all four — on a single kernel, with trust set before launch.</div>
  <div class="foot"><b>specs/blok-vision</b><span>S0 master · S1–S12 · research dossier</span></div>
</section>`;

// ---- assemble ----
const order = [
	cover,
	bet,
	mapSlide,
	divider(1, "Foundation", "The architecture forks. Mostly parallel, high-leverage. S3 ships first — it's bug fixes."),
	...phaseSpecs(1).map(specSlide),
	divider(2, "Studio · Registry · Triggers", "The visible turn: Blok becomes editable and installable."),
	...phaseSpecs(2).map(specSlide),
	divider(
		3,
		"Marketplace · AI · Distribution",
		"The moat: multi-runtime distribution, the auth primitive, the AI-native surface.",
	),
	...phaseSpecs(3).map(specSlide),
	roadmap,
	positioning,
	decisions,
	closing,
];

const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3.7.0/dist/tabler-icons.min.css">
<style>${THEME}${CSS}</style></head><body>${order.join("\n")}</body></html>`;

fs.writeFileSync(path.join(HERE, "deck.html"), html);
console.log(
	`deck.html written — ${order.length} slides (${slides.length} spec + ${order.length - slides.length} static)`,
);
