// Builds a report-style HTML (→ PDF) of the Blok core redesign from redesign-data.json.
// Landscape, full-width OLD/NEW code blocks, pre-wrap so nothing is ever clipped.
const fs = require("node:fs");
const path = require("node:path");
const hljs = require("highlight.js");

const data = JSON.parse(fs.readFileSync(path.join(__dirname, "redesign-data.json"), "utf8"));
const { sections, frame } = data;

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const LANG = {
	ts: "typescript",
	tsx: "typescript",
	js: "javascript",
	json: "json",
	yaml: "yaml",
	bash: "bash",
	text: null,
};
function code(src, lang) {
	const l = LANG[lang] ?? null;
	return l ? hljs.highlight(String(src), { language: l }).value : esc(src);
}

let THEME = "";
try {
	THEME = fs.readFileSync(require.resolve("highlight.js/styles/github-dark.css"), "utf8");
} catch {}
THEME +=
	".hljs{background:transparent}.hljs-comment{color:#7c8696;font-style:italic}.hljs-keyword{color:#7aa2ff}.hljs-string,.hljs-attr{color:#5fd0a6}.hljs-number,.hljs-literal{color:#e0a458}.hljs-title,.hljs-name{color:#8fd3ff}.hljs-built_in,.hljs-type{color:#9bb4ff}.hljs-meta{color:#9aa6b5}";

const CSS = `
:root{--bg:#0A0C10;--bg2:#0E1117;--panel:#12161D;--panel2:#161B23;--border:#222A35;--border2:#2C3644;
--text:#EAEEF5;--muted:#9AA6B5;--faint:#6B7686;--blue:#5C9DFF;--teal:#3FD9A6;--red:#FF7A7A;--green:#43D9A3;--amber:#F5BE5B;
--mono:"SF Mono","JetBrains Mono",ui-monospace,Menlo,Consolas,monospace;--sans:-apple-system,"Segoe UI",Inter,sans-serif}
*{box-sizing:border-box;margin:0;padding:0}
@page{size:A4 landscape;margin:13mm 15mm}
@page:first{margin:0}
html,body{background:var(--bg);color:var(--text);font-family:var(--sans);font-size:13px;line-height:1.5;-webkit-font-smoothing:antialiased}
code{font-family:var(--mono);font-size:.88em;color:#aebbcc;background:var(--panel2);padding:1px 5px;border-radius:4px}
.page-break{break-before:page}
/* cover */
.cover{height:200mm;display:flex;flex-direction:column;justify-content:center;padding:0 26mm;position:relative;break-after:page}
.cover::after{content:"";position:absolute;inset:0;background:radial-gradient(1100px 480px at 100% 0,rgba(92,157,255,.10),transparent 60%)}
.cover .eyebrow{color:var(--muted);letter-spacing:.08em;text-transform:uppercase;font-size:14px;font-weight:500}
.cover h1{font-size:62px;font-weight:600;letter-spacing:-.03em;line-height:1.02;margin:16px 0 0;
  background:linear-gradient(110deg,#fff 5%,var(--blue) 55%,var(--teal));-webkit-background-clip:text;background-clip:text;color:transparent}
.cover .head{font-size:24px;color:var(--text);font-weight:400;margin-top:22px;max-width:760px;line-height:1.4}
.cover .meta{position:absolute;left:26mm;bottom:24mm;color:var(--faint);font-size:13px}
/* section */
.sec{break-before:page;padding-top:4px}
.sec-h{display:flex;align-items:baseline;gap:14px;border-bottom:1px solid var(--border2);padding-bottom:12px;margin-bottom:14px}
.sec-h .num{font-size:15px;color:var(--blue);font-weight:600;font-family:var(--mono)}
.sec-h h2{font-size:27px;font-weight:600;letter-spacing:-.01em}
.intro{font-size:15px;color:var(--muted);line-height:1.55;max-width:1000px;margin-bottom:16px}
.block{margin:14px 0 20px}
.block .blabel{font-size:13px;color:var(--text);font-weight:600;margin-bottom:9px;display:flex;align-items:center;gap:9px}
.block .blabel::before{content:"";width:7px;height:7px;border-radius:99px;background:var(--blue)}
.cmp{display:flex;flex-direction:column;gap:10px}
.pane{border:1px solid var(--border);border-radius:10px;overflow:hidden;background:var(--panel)}
.pane .ph{display:flex;align-items:center;gap:9px;padding:8px 14px;font-size:12.5px;border-bottom:1px solid var(--border)}
.pane.old .ph{background:linear-gradient(90deg,rgba(255,122,122,.10),transparent)}
.pane.old .ph .tag{color:var(--red);font-weight:600}
.pane.old .ph .d{width:8px;height:8px;border-radius:99px;background:var(--red)}
.pane.new .ph{background:linear-gradient(90deg,rgba(67,217,163,.12),transparent)}
.pane.new .ph .tag{color:var(--green);font-weight:600}
.pane.new .ph .d{width:8px;height:8px;border-radius:99px;background:var(--green)}
.pane .cap{margin-left:auto;color:var(--muted);font-size:11.5px;font-weight:400;text-align:right;max-width:60%}
.pane pre{margin:0;padding:13px 16px;background:var(--bg2);overflow:visible}
.pane code.blk{font-family:var(--mono);font-size:11.5px;line-height:1.6;color:#cdd6e3;
  white-space:pre-wrap;word-break:normal;overflow-wrap:anywhere;display:block;background:none;padding:0}
.takeaways{margin-top:14px;border:1px solid var(--border);border-left:3px solid var(--teal);border-radius:10px;background:var(--panel2);padding:14px 18px}
.takeaways h4{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px}
.takeaways ul{margin:0;padding-left:18px}.takeaways li{font-size:13.5px;color:var(--text);margin:5px 0;line-height:1.45}
.takeaways li b{color:var(--teal)}
/* overview + callouts */
.lead-bullets{list-style:none;padding:0;margin:8px 0}
.lead-bullets li{position:relative;padding-left:26px;margin:12px 0;font-size:16px;color:var(--text);line-height:1.5}
.lead-bullets li::before{content:"→";position:absolute;left:0;color:var(--teal);font-weight:700}
.lead-bullets li b{color:var(--blue)}
.callout{border:1px solid var(--border2);border-radius:12px;background:linear-gradient(180deg,rgba(63,217,166,.07),transparent);padding:20px 24px;margin:18px 0}
.callout h3{font-size:17px;margin-bottom:8px}.callout h3 .hl{color:var(--teal)}
.callout p{font-size:15px;color:var(--text);line-height:1.55}
.muted-note{font-size:12.5px;color:var(--faint);margin-top:10px}
h2.page-title{font-size:30px;font-weight:600;letter-spacing:-.02em;margin-bottom:6px}
h2.page-title .n{color:var(--blue)}
.sub{color:var(--muted);font-size:15px;margin-bottom:18px}
`;

function paneBlock(b) {
	return `<div class="block">
    <div class="blabel">${esc(b.label)}</div>
    <div class="cmp">
      <div class="pane old"><div class="ph"><span class="d"></span><span class="tag">BEFORE — today</span><span class="cap">${esc(b.oldCaption)}</span></div><pre><code class="blk">${code(b.oldCode, b.oldLang)}</code></pre></div>
      <div class="pane new"><div class="ph"><span class="d"></span><span class="tag">AFTER — proposed</span><span class="cap">${esc(b.newCaption)}</span></div><pre><code class="blk">${code(b.newCode, b.newLang)}</code></pre></div>
    </div>
  </div>`;
}

function sectionHtml(s, i) {
	const extra =
		s.id === "persistence" && frame.persistenceVerdict
			? `<div class="callout"><h3>Decision — <span class="hl">save every response, use it anywhere</span></h3><p>${esc(frame.persistenceVerdict)}</p></div>`
			: "";
	return `<section class="sec">
    <div class="sec-h"><span class="num">${String(i + 1).padStart(2, "0")}</span><h2>${esc(s.title)}</h2></div>
    <p class="intro">${esc(s.intro)}</p>
    ${extra}
    ${s.blocks.map(paneBlock).join("")}
    <div class="takeaways"><h4>Takeaways</h4><ul>${s.takeaways.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></div>
  </section>`;
}

const cover = `<section class="cover">
  <div class="eyebrow">Blok · core redesign</div>
  <h1>Rewriting the core of Blok</h1>
  <div class="head">${esc(frame.headline)}</div>
  <div class="meta">Old → new, with complete code · workflows · nodes · package · context · persistence · 7 runtimes</div>
</section>`;

const overview = `<section class="sec"><h2 class="page-title">The new model <span class="n">at a glance</span></h2>
  <p class="sub">Everything that changes, in one place. Details and full code follow.</p>
  <ul class="lead-bullets">${frame.overview.map((b) => `<li>${b.replace(/`([^`]+)`/g, "<b>$1</b>")}</li>`).join("")}</ul>
</section>`;

const migration = `<section class="sec"><h2 class="page-title">Migration <span class="n">&amp; compatibility</span></h2>
  <p class="sub">How existing projects move — hybrid, backward-compatible, with a codemod.</p>
  <ul class="lead-bullets">${frame.migration.map((b) => `<li>${b.replace(/`([^`]+)`/g, "<b>$1</b>")}</li>`).join("")}</ul>
  ${
		frame.consistencyNotes?.length && frame.consistencyNotes[0] !== "none"
			? `<div class="muted-note"><b>Design notes:</b> ${frame.consistencyNotes.map(esc).join(" · ")}</div>`
			: ""
	}
</section>`;

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Blok Core Redesign</title>
<style>${THEME}${CSS}</style></head><body>
${cover}${overview}${sections.map(sectionHtml).join("")}${migration}
</body></html>`;

fs.writeFileSync(path.join(__dirname, "redesign.html"), html);
console.log(`redesign.html written — ${sections.length} sections, ${(html.length / 1024).toFixed(0)} KB`);
