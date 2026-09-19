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
| `docker-compose.yml` + `Caddyfile` | Single-VM deployment (worker + HTTPS). See "Deploy to an Oracle Cloud VM". |
| `wrangler.jsonc` + `cf/index.js` | Cloudflare Containers deployment: a Worker in front of one container built from the Dockerfile. See "Deploy to Cloudflare". |

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
3. **Create the paid-amount property.** Settings → Properties → Invoice properties →
   **Create property**, type **Number**, internal name **`branded_pdf_paid_amount`**
   (label e.g. "Branded PDF paid amount"). The worker writes the paid amount printed
   on the latest PDF here, and uses it so each payment re-issues the PDF exactly once.
   Without it, the final write-back is rejected and every invoice lands on **Error**.
4. **Confirm products have images.** `hs_images` (HubSpot's built-in Image Url) is
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

5. **Give the worker a public HTTPS URL.** HubSpot has to reach it. In production
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
6. **Subscribe the private app to invoice events.** Settings → Integrations →
   Private Apps → your app (newer portals: Development → Legacy apps):
   - **Auth** tab → **Show secret** → copy the client secret into `.env` as
     `HS_CLIENT_SECRET`. Every webhook is signed with it; the worker rejects the rest.
   - **Webhooks** tab → **Edit webhooks** → **Target URL** = your `WEBHOOK_URL`.
   - **Create subscription** → object type **Invoice** → event **Property changed** →
     property **Invoice status** (`hs_invoice_status`) → **Subscribe**.
   - **Create subscription** again → **Invoice** → **Property changed** →
     **Branded PDF** (`branded_pdf_status`) → **Subscribe**.
   - **Create subscription** again → **Invoice** → **Property changed** →
     **Amount paid** (`hs_amount_paid`) → **Subscribe**. This re-issues the PDF on a
     part payment (see Payments).
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
| Invoice status → **Paid**, or **Amount paid** changes | Re-issue as PAID / part-paid, once per paid amount, only if the invoice already has a branded PDF. |
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

## Payments

The **Pay** button in the branded PDF is a real link to the invoice's HubSpot
checkout (`hs_invoice_link`). A buyer clicks it in any PDF viewer, pays on HubSpot's
page, and **HubSpot records the payment itself**: it creates the Payment record and
updates the invoice's Amount paid, Balance due and status (→ **Paid**). No worker is
involved in taking the money.

The worker then catches up the PDF:

| On the invoice | PDF re-issued as | Note on the deal |
|---|---|---|
| Part payment (Amount paid changes, still Open) | "Pay remaining €X", with Paid to date and Balance due rows | `Part payment received — … (balance EUR X)` |
| Paid in full (status → Paid) | PAID panel, Balance due €0.00, no Pay button | `Payment received — … re-issued as PAID` |

The invoice number, file name and Branded PDF URL stay the same; the file is
overwritten. If the payment event is missed, the 10-minute reconcile search picks up
paid invoices that were never re-issued.

When the Pay button is left off:
- **No `hs_invoice_link`.** The pay panel is hidden and the notes point to SWIFT. The
  worker logs `no hs_invoice_link — pay button hidden`.
- **Link but no online payment method enabled on the invoice.** The button is
  printed, but HubSpot's page offers no way to pay. The worker logs `no online payment
  methods enabled`. Turn on card or bank debit in the invoice's payment settings. That
  needs HubSpot Payments or Stripe connected to the portal.

### Testing payments

HubSpot has retired payment-link test mode. **Developer test accounts and sandboxes
cannot connect HubSpot Payments or Stripe**, so no card payment can be completed
there. Test in two stages:

1. **Offline**, to check the layout:
   ```bash
   node preview.js --state=part_paid --png
   node preview.js --state=paid --png
   node preview.js --state=nolink --png
   ```
   Open `preview.pdf` from the default state and click **Pay**. It should open the
   sample link.
2. **In the test portal**, to check the event flow. Finalise an invoice and wait for
   `✓ KLS-…`. Open the Branded PDF URL and click **Pay**: it should open HubSpot's
   invoice page (without a pay form, since the test account has no processor). Then,
   on the invoice, **Record payment** for part of the amount. Expect
   `▶ … (payment received (0 → X paid) — re-issuing)` in the log, a new PDF and a note
   on the deal. Record the rest. The status goes **Paid** and the PDF is re-issued as
   PAID. Recording a payment changes the same properties a card payment does, so the
   worker cannot tell them apart.
3. **In the live portal, once**, to check a real card payment. Connect HubSpot Payments
   or Stripe and enable card on a **€1** invoice. Finalise it, click **Pay** in the PDF
   and pay with a real card. Check that the invoice is Paid, the Payment record exists
   and the PAID PDF is on the deal. Refund it from the Payment record.

## Deploy to an Oracle Cloud VM

`docker-compose.yml` runs two containers: the worker, and **Caddy** in front of it.
Caddy serves HTTPS with a free Let's Encrypt certificate, which HubSpot requires.
You don't need a domain: `sslip.io` turns the VM's IP into a hostname
(`129-146-10-20.sslip.io` resolves to `129.146.10.20`).

**1. Create the VM** (Compute → Instances → Create instance)
- Image: **Canonical Ubuntu 24.04**.
- Shape: **VM.Standard.A1.Flex** (Ampere, Always Free), 1 OCPU / 6 GB. Chromium runs
  fine on ARM. If Oracle says *out of capacity*, try another availability domain or
  try again later. `VM.Standard.E2.1.Micro` (1 GB) is also free, but tight for Chromium.
- Networking: a public subnet, with **Assign a public IPv4 address** on.
- SSH keys: download the private key.

**2. Open ports 80 and 443. There are two firewalls.**
- Oracle console → the instance's subnet → **Security List** → **Add ingress rules**:
  source `0.0.0.0/0`, TCP, destination port `80`. Add a second rule for `443`.
- On the VM, because Oracle's Ubuntu image blocks everything but SSH in iptables:
  ```bash
  sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
  sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
  sudo netfilter-persistent save
  ```

**3. Install Docker and get the code**
```bash
ssh -i <key> ubuntu@<public-ip>
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu && exit          # log in again so the group applies
ssh -i <key> ubuntu@<public-ip>
git clone https://github.com/<you>/keliss_invoice_hubspot.git && cd keliss_invoice_hubspot
```
(For a private repo, `git clone` asks for a GitHub username and a personal access
token as the password.)

**4. Create `.env` on the VM** (`nano .env`). It is never committed, so it doesn't
come with the clone:
```bash
DOMAIN=129-146-10-20.sslip.io                          # your IP, dots → dashes
WEBHOOK_URL=https://129-146-10-20.sslip.io/hubspot/webhook
HS_TOKEN=pat-...                                       # private app access token
HS_CLIENT_SECRET=...                                   # private app client secret
AUTO_ON_FINALISE=true
AUTO_SINCE=2026-09-16
RECONCILE_MS=600000
```

**5. Start it**
```bash
docker compose up -d --build        # first build ~5 min (Chromium)
docker compose logs -f              # Caddy: "certificate obtained"; worker: "Listening on :8080"
curl https://129-146-10-20.sslip.io/healthz
```
Both containers restart on their own after a crash or a reboot.

**6. Point the private app's webhook Target URL at `WEBHOOK_URL`** (step 6 of "Before
the first live run"), then **Commit changes** and click **Test**.

**Updating:** `git pull && docker compose up -d --build`. After changing only `.env`:
`docker compose up -d`.

Notes:
- Always Free VMs that stay almost idle for 7 days can be reclaimed by Oracle.
  Upgrading the account to Pay As You Go stops that, and it still costs nothing
  within the free limits.
- The public IP stays with the instance until you terminate it. If it changes,
  update `DOMAIN`, `WEBHOOK_URL` and the HubSpot Target URL.

## Deploy to Cloudflare

Cloudflare's Worker runtime can't run Chromium itself, so this uses **Cloudflare
Containers**. A small Worker (`cf/index.js`) receives HubSpot's webhooks and forwards
them to **one** long-lived container built from the `Dockerfile`, which runs
`worker.js` unchanged. A cron pings it every 5 minutes, so it never goes to sleep:
webhooks don't wait on a cold start, and the reconcile loop keeps running.
Configuration is in `wrangler.jsonc`.

**You need:**
- A Cloudflare account on the **Workers Paid** plan ($5/month; Containers aren't on
  the free plan). A container that is always on (`basic`, 1 GiB) costs a few dollars
  a month more. See Cloudflare's Containers pricing page.
- **Docker Desktop**, installed and running. Wrangler builds the image locally
  (`linux/amd64`) and pushes it.

**1. Log in and set the secrets**
```bash
npm install
npx wrangler login
npx wrangler secret put HS_TOKEN           # paste the private app access token
npx wrangler secret put HS_CLIENT_SECRET   # paste the private app client secret
```
(`wrangler secret put` creates the Worker if it doesn't exist yet. If it complains,
run step 2 first, then come back.)

**2. First deploy, to learn the URL**
```bash
npx wrangler deploy
```
The first build takes a few minutes, because Chromium is in the image. Wrangler
prints the URL, e.g. `https://keliss-invoice.<your-subdomain>.workers.dev`.

**3. Set `WEBHOOK_URL` and deploy again.** In `wrangler.jsonc` → `vars`:
```jsonc
"WEBHOOK_URL": "https://keliss-invoice.<your-subdomain>.workers.dev/hubspot/webhook",
```
Then run `npx wrangler deploy`. The signature check hashes this exact string, so it
has to match what you enter in HubSpot in step 4, character for character.

**4. Point the private app at it.** HubSpot → Settings → Integrations → **Private
Apps** (newer portals: Development → Legacy apps) → your app:
- **Webhooks** tab → **Edit webhooks** → **Target URL** = the `WEBHOOK_URL` above.
- Check the three subscriptions from step 6 of "Before the first live run":
  Invoice status, Branded PDF and Amount paid.
- **Commit changes.**

**5. Check it**
```bash
curl https://keliss-invoice.<your-subdomain>.workers.dev/healthz   # 200 + JSON
```
Then click **Test** on a subscription in HubSpot. It should show a 204. Container
logs (`⇐ webhook: …`, `✓ KLS-…`) are in the Cloudflare dashboard under **Workers &
Pages → keliss-invoice**, on the **Containers** or **Logs** tab. Finalise an invoice
and follow the "Testing payments" steps above.

**Updating:** change the code, then run `npx wrangler deploy`. The container restarts
on the new image. An invoice that was mid-render is caught by HubSpot's retry or the
reconcile search.

`AUTO_SINCE`, `AUTO_ON_FINALISE` and `RECONCILE_MS` are also in `vars`. Change them
there, not in `.env`: `.env` is for running locally only.

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
| No Pay button on the PDF | `hs_invoice_link` empty on the invoice — check the worker log line |
| Pay button opens HubSpot but there's no way to pay | No online payment method on the invoice, or no payment processor connected (always the case in a developer test account) |
| Invoice paid, PDF still says Awaiting payment | `hs_amount_paid` subscription missing or not committed, or the invoice had no branded PDF before the payment (only branded invoices are re-issued) |
| Every render ends in **Error** after upgrading | `branded_pdf_paid_amount` property not created in this portal |

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
