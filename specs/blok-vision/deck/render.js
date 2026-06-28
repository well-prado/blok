const { chromium } = require("playwright");
const path = require("node:path");

(async () => {
	const browser = await chromium.launch();
	const page = await browser.newPage();
	await page.goto(`file://${path.join(__dirname, "deck.html")}`, { waitUntil: "networkidle" });
	await page.waitForTimeout(1200); // let the icon webfont settle
	await page.pdf({
		path: path.join(__dirname, "deck.pdf"),
		preferCSSPageSize: true,
		printBackground: true,
	});
	// also grab a PNG of one spec slide for a quick visual sanity check
	await page.setViewportSize({ width: 1280, height: 720 });
	const slides = await page.$$(".slide");
	if (slides[4]) await slides[4].screenshot({ path: path.join(__dirname, "preview.png") });
	await browser.close();
	console.log("deck.pdf + preview.png written");
})();
