// Render all hi-fi HTML files in apps/studio/_design/ to PNG using Playwright.
// Usage: node apps/studio/_design/_render-screenshots.mjs
// Output: apps/studio/_design/_screenshots/<name>.png

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "/tmp/node_modules/playwright/index.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "_screenshots");

const screens = [
	{ file: "index.html", out: "00-design-canvas.png", w: 1600, h: 1100 },
	{ file: "dashboard-v2.html", out: "01-dashboard.png", w: 1440, h: 900 },
	{ file: "run-detail-v2.html", out: "02-run-detail-pass.png", w: 1440, h: 980 },
	{ file: "run-detail-error-v2.html", out: "03-run-detail-failed.png", w: 1440, h: 980 },
	{ file: "logs-v2.html", out: "04-logs-greenfield.png", w: 1440, h: 900 },
	{ file: "empty-states-v2.html", out: "05-empty-states.png", w: 1600, h: 1280 },
];

const browser = await chromium.launch();
const ctx = await browser.newContext({ deviceScaleFactor: 2 });

for (const s of screens) {
	const page = await ctx.newPage();
	await page.setViewportSize({ width: s.w, height: s.h });
	const url = pathToFileURL(path.join(here, s.file)).href;
	console.log(`render → ${s.out}`);
	await page.goto(url, { waitUntil: "networkidle" });
	// Give Google Fonts an extra beat to swap in (Newsreader + JetBrains Mono)
	await page.waitForTimeout(900);
	await page.screenshot({
		path: path.join(out, s.out),
		fullPage: false,
	});
	await page.close();
}

await ctx.close();
await browser.close();
console.log("done");
