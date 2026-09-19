# KELISS branded invoice worker

Renders a KELISS-branded PDF the moment an invoice is **finalised** in HubSpot, or
whenever a rep sets **Branded PDF = Generate**. HubSpot pushes a webhook to the
worker, which renders the PDF from `invoice-template.html` with Playwright, uploads
it to File Manager, attaches it (as a note) to the invoice and its deal, and writes
the **Branded PDF URL** + status back on the record — typically within 10–20 seconds
of the finalise click.

No polling. A safety-net search runs every 10 minutes to pick up anything a webhook
delivery missed, so the HubSpot API budget is ~150 calls a day at idle plus under
20 per invoice. (The old 30-second poll alone cost ~2,900 searches a day.)

## Files

| File | What it is |
|---|---|
| `worker.js` | The worker: webhook server + render queue + safety-net search. Reconcile `INVOICE_PROPS` and `STATUS` with your portal before running. |
| `invoice-template.html` | Standalone template. Poppins 400/500/600 are embedded as base64 — no remote font race. `window.renderInvoice(data)` fills it. |
| `i18n.js` | Buyer-facing wording per language, plus the language/locale resolver. Add a language here. |
| `preview.js` | Renders the template to `preview.pdf` (and `--png`) with sample data — no HubSpot needed. |
| `sample-data.js` | Sample payloads shared by `preview.js`. |
| `.env.example` | Copy to `.env` and fill in. |
| `Dockerfile` | Production image: Node 22 + Chromium, listens on `$PORT`. |

## Setup

```bash
npm install
npx playwright install chromium
npx playwright install-deps chromium   # Linux only

cp .env.example .env                   # then fill in HS_TOKEN and HS_CLIENT_SECRET
```

Work on the design in isolation first — faster loop, and a template bug looks
nothing like an API bug once they're tangled:

```bash
node preview.js --png             # single item  → preview.pdf + preview.png
node preview.js --stress --png    # 3 items + empty states + long address
node preview.js --lang=fr         # the same invoice in French
node preview.js --all-langs       # preview-en.pdf … preview-pt.pdf, one per language
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

4. **Give the worker a public HTTPS URL.** HubSpot has to reach it. In production
   that is the container's URL (see Production). On your machine, a tunnel:
   ```bash
   # cloudflared: no account needed, prints a https://….trycloudflare.com URL
   cloudflared tunnel --url http://localhost:8080
   # or: ngrok http 8080
   ```
   Put the full URL + path in `.env` as `WEBHOOK_URL=https://<host>/hubspot/webhook`.
   The signature check hashes this exact string, so it must match what you type
   into HubSpot character for character. A quick tunnel gets a new hostname every
   time it starts — update both when it does.
5. **Subscribe the private app to invoice events.** Settings → Integrations →
   Private Apps → your app (newer portals: Development → Legacy apps):
   - **Auth** tab → **Show secret** → copy the client secret into `.env` as
     `HS_CLIENT_SECRET`. Every webhook is signed with it; the worker rejects the rest.
   - **Webhooks** tab → **Edit webhooks** → **Target URL** = your `WEBHOOK_URL`.
   - **Create subscription** → object type **Invoice** → event **Property changed** →
     property **Invoice status** (`hs_invoice_status`) → **Subscribe**.
   - **Create subscription** again → **Invoice** → **Property changed** →
     **Branded PDF** (`branded_pdf_status`) → **Subscribe**.
   - Optional, only if an integration creates invoices already finalised:
     **Invoice** → **Created**.
   - **Commit changes.** Subscriptions do nothing until committed. If HubSpot asks
     for extra scopes when you pick Invoice, accept them.
   - Expand a subscription and click **Test**: the worker logs
     `⇐ webhook: 1 event(s)` and HubSpot shows a 204.

Then start the worker:

```bash
node worker.js
# Listening on :8080 — POST /hubspot/webhook for HubSpot, GET /healthz for monitoring
# Auto-generate on finalise: on (reconcile ignores invoices created before 2026-09-16T00:00:00.000Z)
# Reconcile search every 600000ms
```

## How it triggers

| Event in HubSpot | What the worker does |
|---|---|
| Invoice status → **Open** (finalised) | Generate. Skipped if the invoice already has a Branded PDF URL, or its last attempt errored. |
| **Branded PDF** set to **Generate** | Always generate (re-issue), on any invoice, draft included. |
| Invoice **Created** (optional subscription) | Read the record; generate only if it is already Open. |
| Anything else — including the worker's own status write-backs | Ignored. |

The worker answers HubSpot within milliseconds and renders from an in-memory queue,
one invoice at a time. Every decision is made on a fresh read of the record, never
on the webhook payload, so a duplicate delivery or a retry never renders twice.
HubSpot retries a failed delivery up to 10 times over 24 hours, so a restart or a
short outage loses nothing.

| Setting | Default | Meaning |
|---|---|---|
| `HS_CLIENT_SECRET` | — | Required. Any request not signed by the private app is rejected with 401. |
| `WEBHOOK_URL` | — | The Target URL exactly as typed into HubSpot; it is part of the signature. |
| `PORT` | `8080` | HTTP port. |
| `AUTO_ON_FINALISE` | `true` | `false` = only the manual **Generate** flag triggers a render. |
| `AUTO_SINCE` | worker start time | The safety-net search never auto-generates invoices created before this date. Set it to the go-live date so restarts don't move the line. Webhook events are not date-gated. |
| `RECONCILE_MS` | `600000` | Safety-net search interval. `0` disables it. `POLL_MS` still works as an alias. |
| `WEBHOOK_SETTLE_MS` | `2000` | Pause after a finalise event before reading the record, so HubSpot has finished writing it. |
| `ALLOW_UNSIGNED_WEBHOOKS` | — | `1` skips the signature check. Local testing only. |

**API budget.** One safety-net search every 10 minutes is 144 calls a day. A render
is under 20 calls (read, claim, four association lookups, three batch reads, upload,
note, up to three associations, deal update, final write). A thousand invoices a day
would still sit under 10% of the 250,000/day Starter limit.

## Rep runbook

1. Build the invoice. Fill the KELISS fields (incoterm, destination, lead time)
   **before** finalising — the PDF is generated from what is on the record at that
   moment.
2. **Finalise** it. Within about 15 seconds, refresh: **Branded PDF** shows
   **Generated** and the **Branded PDF URL** link is in the sidebar.
3. Changed something afterwards, or need a fresh copy? Set **Branded PDF** to
   **Generate**. The PDF is re-issued under the same invoice number.
4. Send with **Actions → Create custom email in your CRM**, attaching the PDF from
   the deal's Attachments card. (The default "Send invoice email" only carries
   HubSpot's own plain PDF.)

If **Branded PDF** shows **Error**, the reason is in the **Branded PDF error**
property on the same record — usually a product missing data, not a system fault.
Fix it and set **Generate**; the worker does not retry an errored invoice on its own.

## Production

- Recreate every custom property in the live portal with **identical internal
  names**. Separate private app, separate token, same scopes — never share a token
  across portals.
- Deploy as a container with a public HTTPS URL — Railway, Fly.io, Azure Container
  Apps and Cloud Run all work; `Dockerfile` is included. Set the `.env` values as
  environment variables, with `WEBHOOK_URL` = the service URL + `/hubspot/webhook`
  and `AUTO_SINCE` = the go-live date.
- Point the private app's webhook **Target URL** at it and **Commit changes**.
- Dead man's switch: `GET /healthz` returns 200 with queue and counter details, and
  503 if the safety-net search hasn't run in 3× `RECONCILE_MS`. Point an uptime
  monitor at it; the Dockerfile's `HEALTHCHECK` does the same for the orchestrator.
- One instance. The queue that stops an invoice rendering twice is in memory, so
  run a single replica.
- Keep the test portal as the staging target for template changes.

## Known failure modes

| Symptom | Cause |
|---|---|
| Finalised, nothing happens, no log line | Subscriptions not **committed**, or the Target URL is stale (quick tunnels change hostname on every restart) |
| `webhook rejected: signature mismatch` | `HS_CLIENT_SECRET` is not this app's secret, or `WEBHOOK_URL` differs from HubSpot's Target URL (scheme, host, path, trailing slash) |
| `webhook rejected: timestamp older than 5 minutes` | Server clock is off — sync it |
| PDF generated but KELISS fields blank | Rep finalised before filling them in — fill them, set **Generate** |
| `skipped — last attempt errored` on every reconcile | Expected: errored invoices are left alone until a rep sets **Generate** |
| Invoice stuck on `Generate`, no log line | Search filter value ≠ the dropdown's internal value (`STATUS.queued`) |
| 403 on status write-back | `crm.objects.invoices.write` scope missing — add it, click Update app |
| 400 on the invoice read | A name in `INVOICE_PROPS` doesn't exist in this portal |
| Wrong font in the PDF | A remote font lost the `document.fonts.ready` race — this template embeds Poppins, so this shouldn't happen |
| Product data missing on a line item | Custom product props only copy to line items when a same-named line item property exists; the worker's product fallback covers it — keep both paths |
| Note created but not on the invoice | v4 default association failed silently — `associate()` checks the PUT response |
| Duplicate PDFs on one invoice | The claim-before-render write (set status to `Not generated`) plus the fresh read in `decide()` are what stop a retry or a reconcile hit rendering again — keep both |
| Files upload 400 | `folderPath` and `folderId` both sent — send one (this uses `folderPath` only) |

## Language

The PDF prints in the language set on the HubSpot invoice — the **Language** field,
`hs_language`. Nothing else has to be filled in: change the invoice's language, flag
it **Generate**, and the next PDF comes out in that language.

| Supported | `en` · `fr` · `de` · `es` · `it` · `nl` · `pt` |
|---|---|
| Anything else | Prints in English, and the worker logs `no dictionary for "ja", printing in en` |
| Field is empty | Prints in English |
| `pt-br` | Prints Portuguese, with Brazilian number formatting |

Two locales come out of `i18n.resolve()` and they are deliberately different:

- **Numbers and currency** follow `hs_locale` when it agrees with the language, so a
  US buyer keeps `€2,991.00` and a German one `2.991,00 €`.
- **Dates** always follow the language's own default locale, so an English invoice
  keeps the European "4 September 2026" the spec asks for whatever region HubSpot
  stores.

Not translated, on purpose:

- `legalLine` in `config.js`, the seller address and the bank details — legal text
  and proper nouns, quoted rather than read.
- `hs_comments`, which the rep already writes in the buyer's language.
- Line item names, descriptions and feature bullets — those come from the product
  record, so translating them means translating the products in HubSpot.

**Adding a language:** one entry in `DICTIONARIES` and one in `DEFAULT_LOCALES` in
`i18n.js`. Keys you leave out fall back to English rather than printing blank, so a
partial dictionary is safe to ship. English incoterm wording stays in `config.js`
as the approved source; the other languages carry their own `incoterms` block.
Check the result with `node preview.js --lang=<code> --stress --png`.

## Later

- **More languages** — see the Language section above; each one is two entries in
  `i18n.js`.
- **Multiple replicas** would need the queue moved out of memory (a HubSpot-side
  claim already exists; add a shared lock or a real queue).
