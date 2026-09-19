// Render the template to preview.pdf with sample data — no HubSpot needed.
// Iterate on the design here; a template bug is much easier to see in isolation.
//
//   node preview.js            → single-item invoice (matches the original)
//   node preview.js --stress   → 3 items + empty states + long address (page-break check)
//   node preview.js --png      → also write preview.png (full-page raster, easy to eyeball)
//   node preview.js --lang=fr  → the same invoice in another language (en fr de es it nl pt)
//   node preview.js --all-langs → one PDF per supported language, preview-<lang>.pdf
//   node preview.js --state=paid → PAID panel; also part_paid, nolink (no pay link)

const { chromium } = require("playwright");
const fs = require("fs/promises");
const sample = require("./sample-data.js");

const { SUPPORTED_LANGUAGES } = require("./i18n.js");

const stress = process.argv.includes("--stress");
const png = process.argv.includes("--png");
const allLangs = process.argv.includes("--all-langs");
const lang = (process.argv.find((a) => a.startsWith("--lang=")) || "--lang=en").slice(7);
const state = (process.argv.find((a) => a.startsWith("--state=")) || "--state=awaiting").slice(8);

const STATES = ["awaiting", "part_paid", "paid", "nolink"];
if (!STATES.includes(state)) {
  console.error(`Unknown state "${state}". Supported: ${STATES.join(", ")}`);
  process.exit(1);
}

if (!allLangs && !SUPPORTED_LANGUAGES.includes(lang)) {
  console.error(`Unknown language "${lang}". Supported: ${SUPPORTED_LANGUAGES.join(", ")}`);
  process.exit(1);
}
const langs = allLangs ? SUPPORTED_LANGUAGES : [lang];

(async () => {
  const browser = await chromium.launch();
  const html = await fs.readFile("./invoice-template.html", "utf8");
  const written = [];

  for (const code of langs) {
    // A fresh page per language: renderInvoice() consumes #parts, so a second
    // render in the same document would have nothing left to lay out.
    const page = await browser.newPage({ viewport: { width: 794, height: 1123 }, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: "networkidle" });
    await page.evaluate(([d]) => window.renderInvoice(d), [sample(stress, code, state)]);
    await page.evaluate(() => document.fonts.ready);

    const name = langs.length > 1 ? `preview-${code}` : "preview";
    await page.pdf({
      path: `${name}.pdf`, format: "A4", printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    if (png) await page.screenshot({ path: `${name}.png`, fullPage: true });
    await page.close();
    written.push(`${name}.pdf${png ? " + " + name + ".png" : ""}`);
  }

  await browser.close();
  console.log(`${written.join(", ")} written${stress ? " (stress mode)" : ""}` +
    `${state !== "awaiting" ? ` (state ${state})` : ""}`);
})();
