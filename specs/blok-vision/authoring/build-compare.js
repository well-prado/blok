// Builds a self-contained HTML comparison of Blok workflow-authoring options.
// Code snippets live in snippets.txt (literal, zero escaping); highlighted at build time.
const fs = require("node:fs");
const path = require("node:path");
const hljs = require("highlight.js");

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const L = { ts: "typescript", yaml: "yaml", json: "json", text: null };
function codeOf(snip) {
	const l = L[snip.lang] ?? null;
	const body = l ? hljs.highlight(snip.src.trim(), { language: l }).value : esc(snip.src.trim());
	return `<pre class="code"><code class="hljs">${body}</code></pre>`;
}

function parseSnippets(file) {
	const parts = fs.readFileSync(file, "utf8").split(/^@@@ (\S+) (\S+)\s*$/m);
	const map = {};
	for (let i = 1; i < parts.length; i += 3) map[parts[i]] = { lang: parts[i + 1], src: parts[i + 2] };
	return map;
}
const S = parseSnippets(path.join(__dirname, "snippets.txt"));

// ---------- per-option metadata (code comes from snippets.txt) ----------
const OPT = {
	A: {
		name: "Refined Typed TS DSL",
		tag: "Best version of today",
		pitch:
			"Keep TypeScript as the source of truth, delete the <code>$</code> proxy and every <code>js/</code> string. Each step returns a typed <b>handle</b>; later steps read prior outputs as plain, autocompleted TS — <code>checkStock.inStock</code>, checked by <code>tsc</code>, not stringified and eval'd.",
		who: "Devs first · read-only legible to non-coders · AI-friendly (typed feedback)",
		verdict:
			"Reads like Temporal with GitHub-Actions clarity — type-checked &amp; rename-safe, not a Proxy-to-eval round-trip.",
		pros: [
			"Zero new dialect — it's just TypeScript",
			"<code>tsc</code> is the linter: typo'd ref &rarr; compile error",
			"Full autocomplete, go-to-def, rename-refactor",
			"Rename-safe; references key off the handle, not a name",
		],
		cons: [
			"Build-time codegen to derive step id from variable name",
			"Sound typed Proxy&rarr;binding is fiddly (today's $ is the warning)",
			"Graph&rarr;code round-trip is lossy-ish (nested callbacks)",
			"Developers only — non-coders read but don't author",
		],
	},
	B: {
		name: "Clean Declarative YAML",
		tag: "Readable by anyone",
		pitch:
			"A workflow you read like a recipe, top to bottom. References are <code>${{ steps.checkStock.inStock }}</code> — the exact syntax 100M+ GitHub Actions users know. <code>${{ }}</code> is the <i>only</i> expression marker, so literal vs. reference is unambiguous; pixels live in a sidecar.",
		who: "Non-coders / ops / AI agents (the sweet spot) · devs lose compile-time ref safety",
		verdict: "The most universally readable of the four — anyone who's seen a GitHub Actions file reads it cold.",
		pros: [
			"Reads top-to-bottom like a recipe — steps array <i>is</i> the order",
			"One familiar grammar <code>${{ steps.x.y }}</code>, zero $/js/ctx triad",
			"Literal vs. reference visually obvious (the wrapper)",
			"Loader-time id checking — typo fails at load",
		],
		cons: [
			"YAML is stringly — not IDE-checked like a typed handle (needs schema LSP)",
			"Inside <code>${{ }}</code> you'll want some power — keep it path + vetted helpers, not full JS",
			"New file format: YAML loader + Studio round-trip",
			"A third surface unless YAML replaces JSON",
		],
	},
	C: {
		name: "Code-First Imperative",
		tag: "Cleanest for engineers",
		pitch:
			"A workflow is a plain async function. A step runs, returns a value, you assign it to a <code>const</code>, the next step uses that variable. The dependency graph <i>is</i> the variable bindings — <code>stock.inStock</code> instead of a string that secretly points at a step id. No <code>$</code>, no <code>js/</code>.",
		who: "Devs: ideal · Non-coders: poorly (no visual authoring) · AI: excellent",
		verdict:
			"The most readable option for engineers, bar none — but trades away the visual-authoring audience unless paired with a declarative form.",
		pros: [
			"Zero reference syntax — data flow is variables &amp; return values",
			"Compile-time safety + autocomplete + rename-refactor",
			"One mental model: <code>if</code>/<code>await</code>/<code>Promise.all</code>/<code>try-catch</code>",
			"Layout fully out-of-band, optional, auto-derivable",
		],
		cons: [
			"Non-coders can't author or read it — the hard tradeoff",
			"Static graph extraction is real work; dynamic flow &rarr; 'traced at runtime'",
			"Graph&rarr;code round-trip is a code-generation problem",
			"Imperative escape hatches (raw fetch, shared state) need lint guardrails",
		],
	},
	D: {
		name: "Fluent Pipeline / Hybrid",
		tag: "The sweet spot",
		pitch:
			"An ordered list of named steps where each step's <code>id</code> becomes a variable the next steps read by name — <code>v.out.productId</code>, not a magic string. Reads top-to-bottom like a pipeline, stays 100% declarative so a canvas renders it <i>without executing code</i>, and the reference is a typed handle the compiler checks.",
		who: "Devs: primary win · Non-coders: via the canvas (lossless round-trip) · AI: very high",
		verdict:
			"Reads like a function (Trigger.dev) but stays a renderable list (n8n minus the name-keyed graph) — typed-A meets readable-B, with the $/js/ seam deleted.",
		pros: [
			"One dialect everywhere — same handle in inputs AND <code>branch()</code> conditions",
			"Typo = compile error (handles typed from node's Zod output)",
			"Reads top-to-bottom yet stays declarative &rarr; canvas renders without running code",
			"Rename-safe + layout-free logic; <code>defineNode()</code> untouched",
		],
		cons: [
			"The builder is real engine surface (records edges &rarr; JSON), not just sugar",
			"JSON wire form is wordier: <code>{ from, path }</code> vs <code>v.out.x</code>",
			"Branch-scoped handles can't escape their arm (correct, but a new rule)",
			"Migration: existing $/js/ workflows need a codemod",
		],
	},
};

const ROWS = [
	[
		"Reference syntax",
		"$ / js/ / raw-ctx — 3 dialects",
		"steps.x.field (typed)",
		"${{ steps.x.field }}",
		"plain variable",
		"v.out.field (typed)",
	],
	["Format", "TS + JSON", "TypeScript", "YAML", "TypeScript", "TS (+JSON wire)"],
	["Layout", "none yet", "separate file", "separate file", "separate file", "separate file"],
	["Compile-time safety", "no", "yes", "partial (LSP)", "yes", "yes"],
	["Readable by non-coders", "no", "partial", "yes", "no", "partial"],
	["Canvas renders w/o running", "yes", "partial", "yes", "no (trace)", "yes"],
	["AI-friendly", "low", "high", "high", "high", "high"],
	["Build cost", "—", "medium", "medium", "high", "med-high"],
];
const VKEY = {
	yes: "y",
	no: "n",
	partial: "p",
	"partial (LSP)": "p",
	low: "n",
	high: "y",
	medium: "m",
	"med-high": "m",
	"no (trace)": "n",
	"none yet": "n",
};
const cell = (v, today) => {
	const k = VKEY[v];
	const c = k === "y" ? "y" : k === "n" ? "n" : k === "p" ? "p" : "";
	return `<td class="${c}${today ? " today" : ""}">${esc(v)}</td>`;
};

const TABS = [
	["today", "Today"],
	["A", "A · Typed TS"],
	["B", "B · YAML"],
	["C", "C · Code-first"],
	["D", "D · Pipeline"],
];
const heroPanes = TABS.map(
	([k], i) => `<div class="pane ${i === 0 ? "active" : ""}" data-pane="${k}">${codeOf(S[`wf.${k}`])}</div>`,
).join("");
const heroTabs = TABS.map(
	([k, label], i) => `<button class="tab ${i === 0 ? "active" : ""}" data-tab="${k}">${label}</button>`,
).join("");

function optCard(key) {
	const o = OPT[key];
	return `<section class="card" id="opt-${key}">
    <div class="card-head"><div class="badge">${key}</div>
      <div><h3>${o.name}</h3><div class="tagline">${o.tag}</div></div>
      <div class="verdict">${o.verdict}</div></div>
    <p class="pitch">${o.pitch}</p>
    <div class="who">${o.who}</div>
    <div class="grid2">
      <div><div class="lbl">Data flow — replacing <code>$</code></div>${codeOf(S[`${key}.flow`])}</div>
      <div><div class="lbl">Layout — a separate file</div>${codeOf(S[`${key}.layout`])}</div>
    </div>
    <div class="grid2 proscons">
      <div><div class="lbl up">Pros</div><ul>${o.pros.map((p) => `<li>${p}</li>`).join("")}</ul></div>
      <div><div class="lbl down">Cons / risks</div><ul>${o.cons.map((c) => `<li>${c}</li>`).join("")}</ul></div>
    </div></section>`;
}

let THEME = "";
try {
	THEME = fs.readFileSync(require.resolve("highlight.js/styles/github-dark.css"), "utf8");
} catch {}
THEME +=
	".hljs{background:transparent}.hljs-comment{color:#6b7686;font-style:italic}.hljs-keyword{color:#7aa2ff}.hljs-string,.hljs-attr{color:#5fd0a6}.hljs-number,.hljs-literal{color:#e0a458}.hljs-title,.hljs-name{color:#8fd3ff}.hljs-built_in,.hljs-type{color:#9bb4ff}";

const CSS = `
:root{--bg:#0A0C10;--bg2:#0E1117;--panel:#12161D;--panel2:#161B23;--border:#222A35;--border2:#2C3644;
--text:#EAEEF5;--muted:#9AA6B5;--faint:#6B7686;--blue:#5C9DFF;--teal:#3FD9A6;--red:#FF7A7A;--amber:#F5BE5B;
--mono:"SF Mono","JetBrains Mono",ui-monospace,Menlo,monospace;--sans:-apple-system,"Segoe UI",Inter,sans-serif}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:var(--sans);line-height:1.5;-webkit-font-smoothing:antialiased}
.wrap{max-width:1180px;margin:0 auto;padding:56px 28px 100px}
code{font-family:var(--mono);font-size:.9em;color:#aebbcc;background:var(--panel2);padding:1px 5px;border-radius:4px}
.eyebrow{color:var(--muted);letter-spacing:.06em;text-transform:uppercase;font-size:14px;font-weight:500;display:flex;gap:10px;align-items:center}
.dot{width:8px;height:8px;border-radius:99px;background:var(--blue)}
h1{font-size:42px;font-weight:600;letter-spacing:-.02em;margin:14px 0 0;background:linear-gradient(110deg,#fff,var(--blue) 60%,var(--teal));-webkit-background-clip:text;background-clip:text;color:transparent;display:inline-block}
.lead{font-size:20px;color:var(--muted);margin-top:14px;max-width:880px}
h2{font-size:26px;font-weight:600;letter-spacing:-.01em;margin:64px 0 6px}
h2 .n{color:var(--blue)}
.sec-sub{color:var(--muted);margin-bottom:22px;max-width:880px}
.code{background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:16px 18px;overflow:auto;margin:0}
.code code{font-family:var(--mono);font-size:13.5px;line-height:1.62;background:none;color:#cdd6e3;padding:0;white-space:pre}
.callout{border:1px solid var(--border);border-left:3px solid var(--red);border-radius:10px;background:var(--panel);padding:18px 22px;margin:18px 0}
.callout.good{border-left-color:var(--teal)}
.callout h4{font-size:15px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:10px}
.callout ul{margin:0;padding-left:20px}.callout li{margin:5px 0;color:var(--text)}
.callout li b{color:var(--red)}.callout.good li b{color:var(--teal)}
.hero{border:1px solid var(--border);border-radius:16px;background:var(--panel);overflow:hidden;margin-top:8px}
.tabs{display:flex;gap:4px;padding:10px;background:var(--panel2);border-bottom:1px solid var(--border);flex-wrap:wrap}
.tab{font-family:var(--sans);font-size:14px;font-weight:500;color:var(--muted);background:transparent;border:1px solid transparent;border-radius:8px;padding:8px 16px;cursor:pointer}
.tab:hover{color:var(--text)}
.tab.active{color:#04101f;background:var(--blue);border-color:var(--blue)}
.tab[data-tab="today"].active{background:var(--red);color:#1a0808}
.panes{padding:18px}.pane{display:none}.pane.active{display:block}
.pane .code{border:none;background:transparent;padding:4px}
.learn{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:8px}
.lcard{border:1px solid var(--border);border-radius:12px;background:var(--panel);padding:20px}
.lcard h4{font-size:16px;margin-bottom:8px}.lcard h4 span{color:var(--teal);font-weight:600}
.lcard p{font-size:14px;color:var(--muted);line-height:1.5}
.lcard .take{font-size:13px;color:var(--text);margin-top:10px;padding-top:10px;border-top:1px solid var(--border)}
.lcard .take b{color:var(--teal)}
table.mx{width:100%;border-collapse:collapse;font-size:14px;margin-top:8px}
table.mx th,table.mx td{padding:11px 12px;text-align:left;border-bottom:1px solid var(--border);vertical-align:top}
table.mx thead th{font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.03em;border-bottom:1px solid var(--border2)}
table.mx td.row{color:var(--text);font-weight:500}
table.mx td.y{color:var(--teal)}table.mx td.n{color:var(--red)}table.mx td.p{color:var(--amber)}
table.mx td.today{background:rgba(255,122,122,.06)}table.mx th.bk{color:var(--teal)}
.card{border:1px solid var(--border);border-radius:16px;background:var(--panel);padding:26px;margin-top:22px}
.card-head{display:grid;grid-template-columns:auto 1fr 1.4fr;gap:18px;align-items:center}
.badge{width:44px;height:44px;border-radius:12px;background:linear-gradient(135deg,var(--blue),var(--teal));color:#04101f;font-weight:700;font-size:22px;display:flex;align-items:center;justify-content:center}
.card-head h3{font-size:21px;font-weight:600}.tagline{color:var(--teal);font-size:14px;font-weight:500}
.verdict{font-size:13.5px;color:var(--muted);line-height:1.4;border-left:2px solid var(--border2);padding-left:14px}
.pitch{font-size:15.5px;color:var(--text);line-height:1.6;margin:18px 0 10px;max-width:980px}
.who{font-size:13px;color:var(--faint);margin-bottom:18px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:6px}
.lbl{font-size:12.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px}
.lbl.up{color:var(--teal)}.lbl.down{color:var(--red)}
.proscons{margin-top:18px}.proscons ul{margin:0;padding-left:18px}.proscons li{font-size:13.5px;color:var(--text);margin:6px 0;line-height:1.4}
.rec{border:1px solid var(--border2);border-radius:16px;background:linear-gradient(180deg,rgba(63,217,166,.06),transparent);padding:28px;margin-top:24px}
.rec h2{margin:0 0 12px}.rec p{font-size:16px;color:var(--text);line-height:1.6;margin:10px 0;max-width:1000px}
.rec b{color:var(--teal)}.rec .q{color:var(--muted)}
.foot{margin-top:60px;padding-top:20px;border-top:1px solid var(--border);color:var(--faint);font-size:13px;display:flex;justify-content:space-between}
@media print{.tab{display:none}.pane{display:block!important;margin-bottom:10px}}
`;

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Blok — Workflow Authoring Options</title><style>${THEME}${CSS}</style></head><body><div class="wrap">

<div class="eyebrow"><span class="dot"></span> Blok · authoring rethink</div>
<h1>How should a Blok workflow read?</h1>
<p class="lead">Four directions for writing workflows, nodes, and triggers — each killing the <code>$</code> / <code>js/</code> syntax and moving layout to a separate file. The same "order intake" workflow is shown in every one, so you can compare readability head-to-head. Grounded in a source-level study of n8n and Trigger.dev.</p>

<h2>The same workflow, <span class="n">five ways</span></h2>
<p class="sec-sub">Flip between today and each option. Order intake: validate the body &rarr; check stock via an HTTP node &rarr; branch &rarr; create the order &amp; respond 201, or respond 409.</p>
<div class="hero"><div class="tabs">${heroTabs}</div><div class="panes">${heroPanes}</div></div>

<h2>What's wrong with <span class="n">today</span></h2>
<div class="callout"><h4>The baseline every option must beat</h4><ul>
  <li><b>Three dialects for one idea.</b> <code>$.state.x</code> (a Proxy), <code>"js/ctx.state.x"</code> (a raw string), and bare <code>ctx.*</code> in <code>when:</code> — same concept, three incompatible forms.</li>
  <li><b>The <code>$</code> proxy is invisible magic</b> — it looks like a value but stringifies to <code>"js/ctx.state.x"</code> and gets <code>eval</code>'d at run time. Readers can't tell a reference from a literal.</li>
  <li><b>Typos crash at 2am, not at compile.</b> A wrong id is a runtime <code>MapperResolutionError</code>, never a <code>tsc</code> error.</li>
  <li><b>The <code>branch.when</code> footgun is live</b> — it must be a raw <code>ctx.*</code> string; a <code>$</code> there silently mis-routes (the documented 500).</li>
  <li><b>The data graph is invisible</b> — reading <code>steps[]</code> top-to-bottom doesn't show who feeds whom; you grep <code>$.state.X</code>.</li>
</ul></div>
<div class="callout good"><h4>What's already good (keep it)</h4><ul>
  <li><b><code>defineNode()</code> is clean</b> — Zod in/out, pure <code>execute()</code>. The pain is the <i>wiring</i> layer, not the node.</li>
  <li><b>Ordered <code>steps[]</code> list</b> — reads top-to-bottom; n8n reconstructs order from a name-keyed graph. Keep it.</li>
  <li><b>Layout doesn't exist yet</b> — moving it to a sidecar file is greenfield, zero migration.</li>
</ul></div>

<h2>What we learned from <span class="n">the competition</span></h2>
<div class="learn">
  <div class="lcard"><h4><span>n8n</span> — visual, but fragile</h4><p>Wires steps by mutable display <i>name</i> (<code>"connections": { "Webhook": … }</code>) and stores <code>position:[x,y]</code> <i>inside</i> the workflow. Expressions are name-keyed strings: <code>={{ $('Webhook').json.x }}</code>.</p><div class="take"><b>Take:</b> never key on names; never inline layout — exactly your instinct.</div></div>
  <div class="lcard"><h4><span>Trigger.dev</span> — code-first clarity</h4><p>A workflow is a function. Steps are <code>const x = await task.triggerAndWait(...)</code>; data flow is just variables, <code>tsc</code>-checked. No graph, no expression DSL — but no visual canvas either.</p><div class="take"><b>Take:</b> the variable <i>is</i> the edge — kill the string DSL.</div></div>
  <div class="lcard"><h4><span>GitHub Actions</span> — readable refs</h4><p><code>\${{ steps.build.outputs.url }}</code> reads as English: step &rarr; its output &rarr; the field. One marker for "this is a reference," used by 100M+ people.</p><div class="take"><b>Take:</b> id-based <code>steps.&lt;id&gt;.field</code> is the familiar, readable shape.</div></div>
</div>

<h2>The four <span class="n">options</span> at a glance</h2>
<table class="mx"><thead><tr><th>Criterion</th><th>Today</th><th>A · Typed TS</th><th>B · YAML</th><th>C · Code-first</th><th class="bk">D · Pipeline</th></tr></thead>
<tbody>${ROWS.map((r) => `<tr><td class="row">${esc(r[0])}</td>${cell(r[1], true)}${cell(r[2])}${cell(r[3])}${cell(r[4])}${cell(r[5])}</tr>`).join("")}</tbody></table>

<h2>The options <span class="n">in detail</span></h2>
${optCard("A")}${optCard("B")}${optCard("C")}${optCard("D")}

<div class="rec"><h2>My read <span class="n">— where I'd point</span></h2>
<p><b>Option D (Fluent Pipeline)</b> is the sweet spot <i>for Blok specifically</i>: it deletes the <code>$</code>/<code>js/</code> seam and gives one typed, rename-safe dialect — while staying a declarative ordered list, so the Studio canvas can still render and round-trip it without executing code. That last property is the thing C gives up and the thing your whole visual-Studio vision depends on.</p>
<p><b>Pair it with Option B (YAML) as the declarative wire / non-coder surface.</b> D's builder compiles to exactly the kind of id-based, edge-structured JSON that B's <code>\${{ steps.x.y }}</code> reads from — so devs write typed TS (D), non-coders and AI read/generate YAML (B), and <i>both project to one workflow IR</i> (this is spec S1). The canvas edits the same IR.</p>
<p class="q">A is the safe "best version of today" if you want minimal change. C is the cleanest for engineers but loses the visual round-trip. This isn't final — it's the direction I'd validate first. Tell me which one <i>feels</i> right when you read them, and I'll go deep on it (full grammar, the migration codemod, and a Studio round-trip sketch).</p></div>

<div class="foot"><span>Blok · workflow authoring options</span><span>Same example, 5 ways · grounded in n8n + Trigger.dev source</span></div>
</div>
<script>
document.querySelectorAll(".tab").forEach(function(t){t.addEventListener("click",function(){
  var k=t.getAttribute("data-tab");
  document.querySelectorAll(".tab").forEach(function(x){x.classList.toggle("active",x===t)});
  document.querySelectorAll(".pane").forEach(function(p){p.classList.toggle("active",p.getAttribute("data-pane")===k)});
});});
</script></body></html>`;

const out = path.join(__dirname, "authoring-options.html");
fs.writeFileSync(out, html);
console.log(`wrote ${out} (${(html.length / 1024).toFixed(0)} KB)`);
