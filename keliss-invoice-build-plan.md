# KELISS branded invoice — build plan from here

Picks up where you are now: properties exist on products, line items and invoices,
and you have a private app access token. Everything below is the remaining work.

---

## 0. Confirm the ground before writing code

Two checks, five minutes, and they save an afternoon of confusing 400s.

```bash
export HS_TOKEN=pat-na1-...   # your private app token

# A. Invoice property names, as your portal actually reports them
curl -s https://api.hubapi.com/crm/v3/properties/invoices \
  -H "Authorization: Bearer $HS_TOKEN" \
  | jq -r '.results[] | "\(.name)\t\(.type)\t\(.label)"' | sort > invoice-properties.txt

# B. A real product, with the image and price you care about
curl -s "https://api.hubapi.com/crm/v3/objects/products?limit=3&properties=name,hs_sku,price,hs_images,spec_bullets,list_price" \
  -H "Authorization: Bearer $HS_TOKEN" | jq
```

From A, find the real internal names for invoice number, issue date, due date,
currency and amount billed. They vary between portals. Whatever they are, they go
into `INVOICE_PROPS` in `worker.js` and into `buildPayload`'s field mapping.

From B, confirm `hs_images` comes back populated. That's HubSpot's built-in **Image
Url** property on products, and it's what the worker now reads first, with the
custom `image_url` as fallback.

**Products still missing an image:** upload to File Manager, copy the URL, then
batch-write rather than clicking through records.

```bash
curl -X POST https://api.hubapi.com/crm/v3/objects/products/batch/update \
  -H "Authorization: Bearer $HS_TOKEN" -H "Content-Type: application/json" \
  -d '{"inputs":[
        {"id":"46791911214","properties":{"hs_images":"https://…/flexapro-003wt.jpg"}},
        {"id":"46521738635","properties":{"hs_images":"https://…/aussiemax-g1fd-e.jpg"}}
      ]}'
```

**Never re-import products to fix data.** An import creates new records with new IDs
and orphans every line item pointing at `hs_product_id`. Patch by Record ID, or
restore from the recycle bin (CRM → Products → Actions → Restore records, 90 days).

---

## 1. Project scaffold

```bash
mkdir keliss-invoice-worker && cd keliss-invoice-worker
npm init -y
npm i playwright dotenv
npx playwright install chromium
npx playwright install-deps chromium     # Linux only

# drop in the two files
cp ~/Downloads/worker.js .
cp ~/Downloads/invoice-template.html .

cat > .env <<'ENV'
HS_TOKEN=pat-na1-xxxxxxxx
POLL_MS=30000
TEMPLATE=./invoice-template.html
ENV

printf ".env\nnode_modules/\n*.pdf\n" > .gitignore
```

The token never expires and carries invoice write, deal write and file scopes. Treat
it like a production database password: `.env` only, never a commit, and a separate
token per portal.

---

## 2. Get the template rendering standalone

Work on the design before you connect it to HubSpot. Faster loop, and a template bug
looks nothing like an API bug once they're tangled together.

```bash
cat > preview.js <<'JS'
const { chromium } = require("playwright");
const fs = require("fs/promises");

const sample = {
  dealId: null,
  invoice: {
    number: "KLS-500001", status: "awaiting payment",
    issuedAt: "2026-09-04", dueAt: "2026-09-14", currency: "EUR",
    incoterms: "DDP — duty paid", destination: "Villemandeur, France",
    leadTime: "12 days from payment", paymentTerms: "Net 10 days",
    totalDue: 2161,
  },
  billTo: {
    name: "Philippe Amar", email: "amar.philippe@hotmail.fr",
    lines: ["25 Rue Ambroise Paré", "45700 Villemandeur", "Centre-Val de Loire, France"],
  },
  items: [{
    name: "AussieLux Deluxe", sku: "S005",
    description: "Wall-hung luxury smart toilet",
    imageUrl: "https://placehold.co/600x600/png",
    features: ["Proximity sensor","Booster-pump flushing","Automatic lid operation",
      "Infrared therapy nozzle","Laser foot sensor","Multiple cleansing modes",
      "Automatic flush","Instant water heating","Remote and manual control",
      "Ambient lighting","Automatic UV sterilisation","Anti-splash bubble foam",
      "Integrated water tank","HD LED display"],
    packNote: "Reinforced wall-mounting frame included in the pack",
    qty: 3, unitPrice: 627, listPrice: 660, savePerUnit: 33, amount: 1881,
  }],
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent(await fs.readFile("./invoice-template.html", "utf8"), { waitUntil: "networkidle" });
  await page.evaluate((d) => window.renderInvoice(d), sample);
  await page.evaluate(() => document.fonts.ready);
  await page.pdf({ path: "preview.pdf", format: "A4", printBackground: true,
                   margin: { top: 0, right: 0, bottom: 0, left: 0 } });
  await browser.close();
  console.log("preview.pdf written");
})();
JS

node preview.js && open preview.pdf
```

Iterate here until it matches your original. What actually needs doing:

- **Embed Poppins.** The template references it but doesn't ship it. Download the
  woff2 for the weights you use (400, 500, 600), base64 them, and inline
  `@font-face` rules. Remote font URLs work but add a race; embedded never fails.
- **Check page 2.** Add a second and third line item to the sample and confirm the
  `break-inside: avoid` rules hold and the totals panel doesn't split.
- **Check the empty states.** Remove `listPrice` and confirm the discount row and
  the YOU SAVED strip hide themselves. Remove `imageUrl` and confirm the grid
  doesn't collapse.
- **Check a long address** and a customer name that wraps.

Compare against `KELISS_Invoice_KLS-500001.pdf` side by side at 100% zoom, not
fit-to-window — the mm spacing errors only show at true size.

---

## 3. Point the worker at HubSpot

Open `worker.js` and reconcile three things with your portal:

1. `INVOICE_PROPS` — replace the guessed `hs_*` names with the real ones from
   `invoice-properties.txt`.
2. `buildPayload` — the `p.hs_number`, `p.hs_invoice_date`, `p.hs_due_date`,
   `p.hs_currency`, `p.hs_amount_billed` reads use those same names. Update in step.
3. The dropdown values. The search filter looks for `branded_pdf_status = "Generate"`
   and writes back `"Generated"`, `"Error"`, `"Not generated"`. These must match your
   dropdown's **internal values** exactly, which HubSpot may have slugged
   differently from the labels you typed. Check under Settings → Properties →
   Branded PDF → Edit.

Then a dry run against one invoice:

```bash
node -e '
require("dotenv").config();
const t = process.env.HS_TOKEN;
fetch("https://api.hubapi.com/crm/v3/objects/invoices/search", {
  method: "POST",
  headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
  body: JSON.stringify({ properties: ["hs_number","branded_pdf_status"], limit: 5 }),
}).then(r => r.json()).then(r => console.log(JSON.stringify(r, null, 2)));'
```

If that returns invoices, the token and scopes are right and you can start the loop:

```bash
node worker.js
# Polling every 30000ms…
```

---

## 4. First end-to-end run

In the portal, as a rep would:

1. Deal → add the AussieLux product as a line item, qty 3, unit price 627.
2. Create invoice from the deal. Fill incoterms, destination, lead time, terms.
3. **Finalise it.** Draft invoices still accept edits, so a PDF generated from a
   draft can end up disagreeing with the record.
4. Set **Branded PDF → Generate**.
5. Watch the worker log. Within one poll you want `✓ KLS-500001 → https://…`.
6. Refresh the record. Expect: the note with the PDF attached on the timeline, the
   URL in the sidebar, status `Generated`, and the file on the deal's Attachments card.

Then deliberately break it, because these are the failures you'll hit in real use:

| Scenario | What should happen |
|---|---|
| Product with no `hs_images` | Renders with an empty image cell, no crash |
| Three different products on one invoice | All three rows, page break handled |
| Invoice with no discount | Discount row and YOU SAVED strip hidden |
| Currency USD instead of EUR | `$` formatting throughout |
| Worker killed mid-render | Invoice sits at `Not generated`, rep can re-trigger |
| Bad image URL (404) | Renders without the image rather than hanging |

---

## 5. The rep runbook

Write this down for them; it's three steps they will otherwise improvise around.

1. Build the invoice and **finalise** it.
2. Set **Branded PDF** to **Generate**. Wait ~30 seconds, refresh.
3. Download from the **Branded PDF URL** link in the sidebar.
4. Send with **Actions → Create custom email in your CRM**, attaching the PDF from
   the deal's Attachments. The default "Send invoice email" only carries HubSpot's
   own plain PDF and has no attachment option.

If **Branded PDF** shows **Error**, the reason is in the **Branded PDF error**
property on the same record — usually a product missing data, not a system fault.

---

## 6. Production

1. Recreate every property in the live portal with **identical internal names**.
   Fastest route is the properties API against both portals:
   ```bash
   curl -s https://api.hubapi.com/crm/v3/properties/products \
     -H "Authorization: Bearer $TEST_TOKEN" | jq '.results[] | select(.name | test("^(spec_bullets|list_price|pack_note|image_url)$"))'
   ```
   then POST each object to `/crm/v3/properties/products` on live.
2. Separate private app, separate token, same scopes. Never share a token across
   portals — a bug in test shouldn't be able to write to live.
3. Deploy the worker as a container (it needs Chromium, so serverless is awkward).
   Railway, Fly.io or Azure Container Apps all work; a `node:22-slim` base plus
   `npx playwright install --with-deps chromium` is the whole Dockerfile.
4. Add a dead man's switch: if the worker hasn't polled in 10 minutes, alert
   yourself. A silently dead worker looks identical to "HubSpot is slow today" from
   a rep's seat.
5. Keep the test portal alive as the staging target for template changes.

---

## 7. Known failure modes

| Symptom | Cause |
|---|---|
| Invoice stuck on `Generate`, no log line | Search filter value doesn't match the dropdown's internal value |
| 403 on the status write-back | `crm.objects.invoices.write` missing; add the scope and click Update app — the existing token picks it up |
| 400 on the invoice read | A name in `INVOICE_PROPS` doesn't exist in this portal |
| PDF has the wrong font | `document.fonts.ready` resolved before a remote font loaded — embed the font |
| Product data missing on the line item | Custom product properties only copy to line items when a line item property of the same internal name exists; the worker's product fallback covers it, keep both paths |
| Note created but not visible on the invoice | v4 default association failed silently — check the PUT response, not just the note POST |
| Duplicate PDFs on one invoice | The claim-before-render write was removed; it's what stops the next poll picking up the same record |
| Files upload 400 | `folderPath` and `folderId` both sent; send one |

---

## 8. Later, if it's worth it

- **Drop the polling** if your private app shows a Webhooks tab: subscribe to
  `invoice.propertyChange` on `branded_pdf_status` and keep the same handler.
- **Auto-generate on finalise** instead of a manual trigger, once reps trust it.
  Subscribe to the status change to `Open` and skip the dropdown entirely.
- **Multi-currency and language** — the template's `Intl.NumberFormat` call already
  takes the invoice currency; a `locale` field on the invoice would let you ship
  French-language invoices to EU buyers from the same template.
