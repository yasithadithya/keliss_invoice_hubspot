// Render the template to preview.pdf with sample data — no HubSpot needed.
// Iterate on the design here; a template bug is much easier to see in isolation.
//
//   node preview.js            → single-item invoice (matches the original)
//   node preview.js --stress   → 3 items + empty states + long address (page-break check)
//   node preview.js --png      → also write preview.png (full-page raster, easy to eyeball)

const { chromium } = require("playwright");
const fs = require("fs/promises");
const sample = require("./sample-data.js");

const stress = process.argv.includes("--stress");
const png = process.argv.includes("--png");

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 794, height: 1123 }, deviceScaleFactor: 2 });
  await page.setContent(await fs.readFile("./invoice-template.html", "utf8"), { waitUntil: "networkidle" });
  await page.evaluate((d) => window.renderInvoice(d), sample(stress));
  await page.evaluate(() => document.fonts.ready);
  await page.pdf({
    path: "preview.pdf", format: "A4", printBackground: true,
    margin: { top: 0, right: 0, bottom: 0, left: 0 },
  });
  if (png) await page.screenshot({ path: "preview.png", fullPage: true });
  await browser.close();
  console.log(`preview.pdf written${png ? " + preview.png" : ""}${stress ? " (stress mode)" : ""}`);
})();
