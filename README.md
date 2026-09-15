# KELISS branded invoice worker

Polls HubSpot for finalised invoices flagged **Branded PDF = Generate**, renders a
KELISS-branded PDF from `invoice-template.html` with Playwright, uploads it to File
Manager, attaches it (as a note) to the invoice and its deal, and writes the
**Branded PDF URL** + status back on the record.

## Files

| File | What it is |
|---|---|
| `worker.js` | The polling worker. Reconcile `INVOICE_PROPS` and `STATUS` with your portal before running. |
| `invoice-template.html` | Standalone template. Poppins 400/500/600 are embedded as base64 — no remote font race. `window.renderInvoice(data)` fills it. |
| `preview.js` | Renders the template to `preview.pdf` (and `--png`) with sample data — no HubSpot needed. |
| `sample-data.js` | Sample payloads shared by `preview.js`. |
| `.env.example` | Copy to `.env` and fill in. |

## Setup

```bash
npm install
npx playwright install chromium
npx playwright install-deps chromium   # Linux only

cp .env.example .env                   # then edit HS_TOKEN
```

Work on the design in isolation first — faster loop, and a template bug looks
nothing like an API bug once they're tangled:

```bash
node preview.js --png             # single item  → preview.pdf + preview.png
node preview.js --stress --png    # 3 items + empty states + long address
```

## Before the first live run

1. **Confirm invoice property names.** They vary between portals.
   ```bash
   curl -s https://api.hubapi.com/crm/v3/properties/invoices \
     -H "Authorization: Bearer $HS_TOKEN" \
     | jq -r '.results[] | "\(.name)\t\(.type)\t\(.label)"' | sort > invoice-properties.txt
   ```
   Put the real internal names for number/issue date/due date/currency/amount into
   `INVOICE_PROPS` in `worker.js`.
2. **Confirm the dropdown internal values.** The search filter looks for
   `branded_pdf_status = "Generate"` and writes back `Generated` / `Error` /
   `Not generated`. These must match the dropdown's **internal values** (Settings →
   Properties → Branded PDF → Edit), which HubSpot may have slugged differently from
   your labels. Update `STATUS` in `worker.js` if so.
3. **Confirm products have images.** `hs_images` (HubSpot's built-in Image Url) is
   read first, custom `image_url` is the fallback. Fix missing images by **batch
   update by Record ID** — never re-import (a re-import mints new IDs and orphans
   every line item pointing at `hs_product_id`).

Dry run the read path:

```bash
node -e 'require("dotenv").config();const t=process.env.HS_TOKEN;
fetch("https://api.hubapi.com/crm/v3/objects/invoices/search",{method:"POST",
  headers:{Authorization:`Bearer ${t}`,"Content-Type":"application/json"},
  body:JSON.stringify({properties:["hs_number","branded_pdf_status"],limit:5})})
  .then(r=>r.json()).then(r=>console.log(JSON.stringify(r,null,2)));'
```

Then start the loop:

```bash
node worker.js
# Polling every 30000ms…
```

## Rep runbook

1. Build the invoice and **finalise** it. (A PDF from a draft can disagree with the
   record once the draft is edited.)
2. Set **Branded PDF** to **Generate**. Wait ~30s, refresh.
3. Download from the **Branded PDF URL** link in the sidebar.
4. Send with **Actions → Create custom email in your CRM**, attaching the PDF from
   the deal's Attachments card. (The default "Send invoice email" only carries
   HubSpot's own plain PDF.)

If **Branded PDF** shows **Error**, the reason is in the **Branded PDF error**
property on the same record — usually a product missing data, not a system fault.

## Production

- Recreate every custom property in the live portal with **identical internal
  names**. Separate private app, separate token, same scopes — never share a token
  across portals.
- Deploy as a container (it needs Chromium). `node:22-slim` base +
  `npx playwright install --with-deps chromium` is the whole Dockerfile.
- Add a dead man's switch: alert if the worker hasn't polled in ~10 min. (Hook point
  is marked in `worker.js`'s main loop.)
- Keep the test portal as the staging target for template changes.

## Known failure modes

| Symptom | Cause |
|---|---|
| Invoice stuck on `Generate`, no log line | Search filter value ≠ the dropdown's internal value (`STATUS.trigger`) |
| 403 on status write-back | `crm.objects.invoices.write` scope missing — add it, click Update app |
| 400 on the invoice read | A name in `INVOICE_PROPS` doesn't exist in this portal |
| Wrong font in the PDF | A remote font lost the `document.fonts.ready` race — this template embeds Poppins, so this shouldn't happen |
| Product data missing on a line item | Custom product props only copy to line items when a same-named line item property exists; the worker's product fallback covers it — keep both paths |
| Note created but not on the invoice | v4 default association failed silently — `associate()` checks the PUT response |
| Duplicate PDFs on one invoice | The claim-before-render write (set status to `Not generated`) is what stops the next poll re-picking the record — keep it |
| Files upload 400 | `folderPath` and `folderId` both sent — send one (this uses `folderPath` only) |

## Later

- **Drop polling** for a `invoice.propertyChange` webhook on `branded_pdf_status`,
  same handler.
- **Auto-generate on finalise** by subscribing to the status change to `Open`.
- **Multi-language** — `renderInvoice` already honours `invoice.currency` and an
  optional `invoice.locale`; add a `locale` field to ship French-language invoices.
