/**
 * KELISS branded invoice worker
 *
 * Event-driven. HubSpot POSTs a webhook the moment an invoice is finalised
 * (hs_invoice_status → open) or a rep flags Branded PDF = Generate. The
 * worker acknowledges at once, then renders the branded PDF from
 * invoice-template.html, uploads it to the Files API, attaches it to the
 * invoice and its deal as a note, and writes the URL + status back.
 *
 * A slow reconcile search (every 10 minutes by default) catches anything a
 * webhook delivery missed. API budget: ~150 calls a day at idle plus under
 * 20 per invoice — not one search per poll.
 *
 *   npm i playwright dotenv
 *   npx playwright install chromium
 *   node worker.js
 *
 * .env — see .env.example for the full list
 *   HS_TOKEN=pat-na1-...                   private app access token
 *   HS_CLIENT_SECRET=...                   private app → Auth tab → Show secret; signs every webhook
 *   WEBHOOK_URL=https://…/hubspot/webhook  exactly as entered in the private app's Webhooks tab
 *   PORT=8080
 *   RECONCILE_MS=600000                    0 disables the safety-net search
 *   AUTO_ON_FINALISE=true                  false = only the manual Generate flag triggers
 *   AUTO_SINCE=2026-09-16                  reconcile never auto-generates invoices created before this
 *   TEMPLATE=./invoice-template.html
 */

require("dotenv").config();
const fs = require("fs/promises");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { chromium } = require("playwright");

const API = process.env.HS_API_BASE || "https://api.hubapi.com"; // override only for tests
const TOKEN = process.env.HS_TOKEN;
const TEMPLATE = process.env.TEMPLATE || "./invoice-template.html";

// Webhook server
const CLIENT_SECRET = process.env.HS_CLIENT_SECRET || "";
const ALLOW_UNSIGNED = process.env.ALLOW_UNSIGNED_WEBHOOKS === "1";
const PORT = Number(process.env.PORT || 8080);
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";
const WEBHOOK_PATH = WEBHOOK_URL ? new URL(WEBHOOK_URL).pathname : "/hubspot/webhook";
const SETTLE_MS = Number(process.env.WEBHOOK_SETTLE_MS ?? 2000);

// Triggers. POLL_MS is honoured as a legacy alias for RECONCILE_MS.
const RECONCILE_MS = Number(process.env.RECONCILE_MS ?? process.env.POLL_MS ?? 10 * 60 * 1000);
const AUTO_ON_FINALISE = (process.env.AUTO_ON_FINALISE ?? "true") !== "false";
const AUTO_SINCE_MS = process.env.AUTO_SINCE ? Date.parse(process.env.AUTO_SINCE) : Date.now();

// Adjust these to the internal names your portal actually reports from
//   GET /crm/v3/properties/invoices
const CONFIG = require("./config.js");
const REPS = require("./reps.json");
const i18n = require("./i18n.js");

// Spec-aligned property sets. keliss_* replace the earlier incoterms/destination/
// lead_time/payment_terms_note properties.
const INVOICE_PROPS = [
  // identity + dates
  "hs_number",
  "hs_invoice_date",
  "hs_due_date",
  "hs_invoice_status",
  "hs_comments",
  "hs_timezone",
  "hs_language",
  "hs_locale",
  "hubspot_owner_id",
  // money
  "hs_currency",
  "hs_subtotal",
  "hs_discounts_total",
  "hs_taxes_total",
  "hs_fees_total",
  "hs_amount_billed",
  "hs_amount_paid",
  "hs_balance_due",
  // pay box
  "hs_invoice_link",
  "hs_allowed_payment_methods",
  "hs_allow_partial_payments",
  // custom
  "keliss_invoice_number",
  "keliss_incoterm",
  "keliss_destination",
  "keliss_lead_time_days",
  "keliss_document_type",
  "branded_pdf_status",
  "branded_pdf_url",
];

// Must match the dropdown's internal option values exactly.
const STATUS = {
  idle: "Not Generated",
  queued: "Generate",
  done: "Generated",
  error: "Error",
};

const LINE_ITEM_PROPS = [
  "name",
  "hs_sku",
  "quantity",
  "price",              // list price per unit
  "amount",             // net line amount after discount
  "discount",
  "hs_total_discount",  // drives the SAVE badge
  "hs_pre_discount_amount",
  "description",        // subtitle + ◎ bullets + * note
  "hs_product_id",
  "hs_images",
];

const PRODUCT_PROPS = ["name", "hs_sku", "price", "description", "hs_images"];

/* ------------------------------------------------------------------ HubSpot */

async function hs(pathname, init = {}) {
  const res = await fetch(`${API}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(init.body && !(init.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    throw new Error(`${init.method || "GET"} ${pathname} → ${res.status} ${await res.text()}`);
  }
  return res.status === 204 ? null : res.json();
}

// Same as hs(), but returns { ok, status, data } instead of throwing.
async function hsTry(pathname, init = {}) {
  try {
    return { ok: true, data: await hs(pathname, init) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

const setInvoice = (id, properties) =>
  hs(`/crm/v3/objects/invoices/${id}`, { method: "PATCH", body: JSON.stringify({ properties }) });

const assocIds = (invoiceId, toType) =>
  hs(`/crm/v3/objects/invoices/${invoiceId}/associations/${toType}`)
    .then((r) => (r.results || []).map((x) => x.toObjectId || x.id))
    .catch(() => []);

const batchRead = (objectType, ids, properties) =>
  ids.length
    ? hs(`/crm/v3/objects/${objectType}/batch/read`, {
        method: "POST",
        body: JSON.stringify({ properties, inputs: ids.map((id) => ({ id: String(id) })) }),
      }).then((r) => r.results || [])
    : Promise.resolve([]);

/* ------------------------------------------------------------------ payload */

// Owners change rarely — one list call per process, then serve from memory.
let ownersCache = null;
async function getOwner(ownerId) {
  if (!ownerId) return null;
  if (!ownersCache) {
    const res = await hsTry("/crm/v3/owners?limit=100");
    ownersCache = new Map((res.ok ? res.data.results || [] : []).map((o) => [String(o.id), o]));
  }
  return ownersCache.get(String(ownerId)) || null;
}

/**
 * Line item description convention from the spec:
 *   line 1        → subtitle beside the SKU
 *   ◎ lines       → feature bullets, max 14, two columns
 *   * line        → sand note box
 *   "…and more"   → dropped
 */
function parseDescription(raw) {
  const out = { subtitle: null, features: [], note: null };
  if (!raw) return out;

  for (const line of String(raw).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    if (/^[◎◉○*]/.test(line) === false && !out.subtitle) {
      out.subtitle = line;
    } else if (/^[◎◉○]/.test(line)) {
      const text = line.replace(/^[◎◉○]\s*/, "");
      // "…and more" filler, in whichever language the product copy was written
      if (/^(\.{3}|…|and more|et encore|und mehr|y m[áa]s|e altro|en meer|e mais)/i.test(text)) continue;
      out.features.push(text);
    } else if (line.startsWith("*")) {
      out.note = line.replace(/^\*\s*/, "");
    }
  }
  out.features = out.features.slice(0, 14);
  return out;
}

/**
 * HubSpot stores invoice dates as end-of-day timestamps, so formatting in UTC
 * can land on the wrong calendar day. Always format in the portal time zone.
 */
// The v3 API returns datetimes as ISO strings; older payloads use epoch ms.
function toMs(value) {
  if (value === null || value === undefined || value === "") return null;
  const ms = /^\d+$/.test(String(value)) ? Number(value) : Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function formatDate(value, timeZone, locale, opts) {
  const ms = toMs(value);
  if (ms === null) return null;
  return new Intl.DateTimeFormat(locale || "en-IE", {
    timeZone: timeZone || "UTC",
    day: "numeric", month: "long", year: "numeric",
    ...opts,
  }).format(new Date(ms));
}

/**
 * KLS-BD-500001 — brand code + rep initials + the digits of HubSpot's own
 * hs_number. Parsed, never counted, so the sequences can't drift or collide.
 * Issued once and read back from keliss_invoice_number ever after.
 */
function buildInvoiceNumber(existing, hsNumber, initials) {
  if (existing) return existing; // never renumber, even if the owner changes
  const digits = String(hsNumber || "").split("-").filter(Boolean).pop() || "";
  return [CONFIG.brand.code, initials, digits].filter(Boolean).join("-");
}

function deriveState(status, billed, balance) {
  if (status === "draft") return "draft";
  if (status === "voided") return "voided";
  if (status === "paid" || balance === 0) return "paid";
  if (balance > 0 && balance < billed) return "part_paid";
  return "awaiting";
}

const CURRENCY_LABELS = { EUR: "EUR €", USD: "USD $", GBP: "GBP £", AUD: "AUD A$" };

async function buildPayload(invoice) {
  const id = invoice.id;
  const p = invoice.properties;
  const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

  const [lineItemIds, contactIds, companyIds, dealIds] = await Promise.all([
    assocIds(id, "line_items"),
    assocIds(id, "contacts"),
    assocIds(id, "companies"),
    assocIds(id, "deals"),
  ]);

  const [lineItems, contacts, companies, owner] = await Promise.all([
    batchRead("line_items", lineItemIds, LINE_ITEM_PROPS),
    batchRead("contacts", contactIds, ["firstname", "lastname", "email", "address", "city", "zip", "state", "country"]),
    batchRead("companies", companyIds, ["name", "address", "address2", "city", "zip", "state", "country"]),
    getOwner(p.hubspot_owner_id),
  ]);

  // Custom product properties only copy to line items when a line item property
  // of the same internal name exists — fetch the products regardless.
  const productIds = [...new Set(lineItems.map((li) => li.properties.hs_product_id).filter(Boolean))];
  const products = await batchRead("products", productIds, PRODUCT_PROPS);
  const productById = Object.fromEntries(products.map((pr) => [pr.id, pr.properties]));

  const contact = contacts[0]?.properties || {};
  const company = companies[0]?.properties || {};
  const contactName = [contact.firstname, contact.lastname].filter(Boolean).join(" ");
  const tz = p.hs_timezone || "UTC";

  // Everything the buyer reads follows the Language field on the invoice.
  const lang = i18n.resolve(p.hs_language, p.hs_locale);
  const S = i18n.dictionary(lang.lang);
  if (lang.fallback) {
    console.warn(`  ↳ no dictionary for "${lang.requested}", printing in ${lang.lang}`);
  }

  // Buyer: company first with the contact as "Attn.", else the contact.
  // Never hs_recipient_company_* — on this portal those hold a Hong Kong
  // address that is not the buyer (spec p.6).
  const companyLines = [company.address, company.address2,
    [company.zip, company.city].filter(Boolean).join(" "), company.state, company.country].filter(Boolean);
  const contactLines = [contact.address,
    [contact.zip, contact.city].filter(Boolean).join(" "), contact.state, contact.country].filter(Boolean);

  // Rep: name and email from HubSpot, everything else from reps.json.
  const repProfile = REPS[String(p.hubspot_owner_id)] || {};
  const repName = owner ? [owner.firstName, owner.lastName].filter(Boolean).join(" ") : "";
  const rep = {
    name: repName || null,
    email: owner?.email || null,
    // reps.json wins; otherwise first letters of the owner's name ("Yasith Adithya" → "YA").
    initials: repProfile.initials ||
      repName.split(/\s+/).filter(Boolean).map((w) => w[0].toUpperCase()).join("").slice(0, 3) || null,
    title: repProfile.title || null,
    phone: repProfile.phone || null,
    whatsapp: repProfile.whatsapp || null,
    photoUrl: repProfile.photoUrl || null,
    signatureUrl: repProfile.signatureUrl || null,
  };

  // Totals: every figure from the invoice record, never derived.
  //
  // HubSpot applies discounts at two levels and reports both in one property:
  //   line level     already deducted from the line's `amount`, and therefore
  //                  from hs_subtotal (a % or amount on the line item)
  //   invoice level  deducted after hs_subtotal, so hs_amount_billed comes out
  //                  below it (a discount on the invoice itself)
  // hs_discounts_total is the sum of the two, so subtracting it from
  // hs_subtotal double-counts the line-level half. Add those back on first to
  // get the list value the buyer is being shown a discount against.
  const round2 = (v) => Math.round(v * 100) / 100;
  const lineDiscounts = round2(lineItems.reduce(
    (sum, li) => sum + (num(li.properties.hs_total_discount) || 0), 0));
  const gross = round2((num(p.hs_subtotal) || 0) + lineDiscounts);
  const discounts = num(p.hs_discounts_total) || 0;
  const subtotal = round2(gross - discounts);
  const fees = num(p.hs_fees_total) || 0;
  const taxes = num(p.hs_taxes_total) || 0;
  const billed = num(p.hs_amount_billed) || 0;
  const balance = num(p.hs_balance_due) ?? billed;

  // Spec: total must equal gross − discount + fees + tax, otherwise stop.
  const expected = round2(subtotal + fees + taxes);
  if (billed && Math.abs(expected - billed) > 0.01) {
    throw new Error(
      `Totals do not reconcile: gross ${gross} (hs_subtotal ${p.hs_subtotal} + ` +
      `${lineDiscounts} line discounts) − discount ${discounts} + fees ${fees} + ` +
      `tax ${taxes} = ${expected} but amount billed=${billed}`);
  }

  const currency = p.hs_currency || "EUR";
  const bank = CONFIG.bankAccounts[currency];
  if (!bank) throw new Error(`No bank account configured for ${currency} — cannot issue this invoice`);

  const incoterm = S.incoterms?.[p.keliss_incoterm] || CONFIG.incoterms[p.keliss_incoterm] || null;
  const leadDays = num(p.keliss_lead_time_days);
  const dueMs = toMs(p.hs_due_date);
  const issuedMs = toMs(p.hs_invoice_date);
  const termDays = dueMs !== null && issuedMs !== null
    ? Math.round((dueMs - issuedMs) / 86400000)
    : null;

  const methods = (p.hs_allowed_payment_methods || "").split(";").filter(Boolean);
  const cardBrands = methods.map((m) => CONFIG.cardBrandLabels[m]).filter(Boolean);

  const state = deriveState(p.hs_invoice_status, billed, balance);
  const invoiceNumber = buildInvoiceNumber(p.keliss_invoice_number, p.hs_number, rep.initials);

  return {
    dealId: dealIds[0] || null,
    contactId: contactIds[0] || null,
    // The template's own English defaults are replaced with these at render.
    i18n: { lang: lang.lang, locale: lang.locale, strings: S },
    // Written back to keliss_invoice_number when it was issued on this run.
    // Never from a draft: hs_number is INV-DRAFT until finalise, and the
    // number is issued once and kept forever.
    issuedNumber: p.keliss_invoice_number || p.hs_invoice_status === "draft" ? null : invoiceNumber,

    invoice: {
      number: invoiceNumber,
      // An explicit keliss_document_type is the admin's own wording and prints
      // verbatim; only the default is translated.
      documentType: p.keliss_document_type || S.documentType,
      state,
      statusLabel: S.status[state],
      currency,
      currencyLabel: CURRENCY_LABELS[currency] || currency,
      numberLocale: lang.locale,
      issuedAtLabel: formatDate(p.hs_invoice_date, tz, lang.dateLocale),
      dueAtLabel: formatDate(p.hs_due_date, tz, lang.dateLocale),
      signatureDateLabel: i18n.signatureDate(
        formatDate(p.hs_invoice_date, tz, lang.dateLocale, { month: "short" }), lang.lang),
      incotermLabel: incoterm?.label || p.keliss_incoterm || null,
      destination: p.keliss_destination ||
        [company.city || contact.city, company.country || contact.country].filter(Boolean).join(", ") || null,
      leadTimeLabel: leadDays ? i18n.fmt(S.notes.leadTime, { days: leadDays }) : null,
      paymentTerms: termDays === null ? null
        : termDays <= 0 ? S.notes.dueOnReceipt
        : i18n.fmt(S.notes.netDays, { days: termDays }),
      payLink: p.hs_invoice_link || null,
      allowPartial: p.hs_allow_partial_payments === "true",
      cardBrands,
      howToPay: cardBrands.length ? S.notes.howToPayCard : S.notes.howToPaySwift,
      deliveryNote: incoterm?.delivery || null,
      dispatchNote: leadDays
        ? i18n.fmt(S.notes.dispatchWithLead, { days: leadDays })
        : S.notes.dispatchNoLead,
      comments: (p.hs_comments || "").replace(/<[^>]+>/g, "").trim() || null,
    },

    totals: {
      gross, discounts, subtotal, fees, taxes,
      total: billed,
      paidToDate: num(p.hs_amount_paid) || 0,
      balanceDue: balance,
      discountPct: gross > 0 && discounts > 0 ? Math.round((discounts / gross) * 100) : 0,
    },

    billTo: {
      name: company.name || contactName || "",
      attn: company.name && contactName ? contactName : null,
      email: contact.email || null,
      lines: companyLines.length ? companyLines : contactLines,
    },

    items: lineItems.map((li) => {
      const lp = li.properties;
      const prod = productById[lp.hs_product_id] || {};
      const qty = num(lp.quantity) || 0;
      const amount = num(lp.amount) || 0;
      const listPrice = num(lp.price) || 0;
      const totalDiscount = num(lp.hs_total_discount) || 0;
      const parsed = parseDescription(lp.description || prod.description);

      return {
        name: (lp.name || prod.name || "").trim(),
        sku: lp.hs_sku || prod.hs_sku || null,
        subtitle: parsed.subtitle,
        features: parsed.features,
        note: parsed.note,
        imageUrl: lp.hs_images || prod.hs_images || null,
        qty,
        amount,
        unitPrice: qty ? amount / qty : 0,          // spec: amount ÷ quantity
        listPrice: totalDiscount > 0 ? listPrice : null, // struck only when discounted
        savePerUnit: qty && totalDiscount > 0 ? totalDiscount / qty : null,
      };
    }),

    company: {
      legalName: CONFIG.brand.legalName,
      logoUrl: CONFIG.brand.logoUrl,
      site: CONFIG.brand.site,
      sellerName: CONFIG.seller.name,
      sellerLines: CONFIG.seller.lines,
      registrationNo: CONFIG.seller.registrationNo,
      policyLine: i18n.fmt(S.notes.policyLine, {
        brand: CONFIG.brand.name,
        url: CONFIG.brand.deliveryPolicyUrl,
      }),
      legalLine: CONFIG.legalLine,
    },

    bank,
    rep,
  };
}

const imageCache = new Map();

async function fetchImageAsDataUri(url) {
  if (!url) return null;
  if (imageCache.has(url)) return imageCache.get(url);

  let dataUri = null;
  try {
    // Try authenticated first, then plain — hubfs URLs can be either.
    for (const headers of [{ Authorization: `Bearer ${TOKEN}` }, {}]) {
      const res = await fetch(url, { headers });
      if (!res.ok) continue;
      const type = res.headers.get("content-type") || "image/jpeg";
      const buf = Buffer.from(await res.arrayBuffer());
      dataUri = `data:${type};base64,${buf.toString("base64")}`;
      break;
    }
    if (!dataUri) console.warn(`  ↳ image fetch failed, rendering placeholder: ${url}`);
  } catch (err) {
    console.warn(`  ↳ image error (${err.message}), rendering placeholder: ${url}`);
  }

  imageCache.set(url, dataUri);
  return dataUri;
}

async function embedImages(payload) {
  const rep = payload.rep;
  await Promise.all([
    ...payload.items.map(async (item) => {
      item.imageUrl = await fetchImageAsDataUri(item.imageUrl);
    }),
    (async () => { rep.photoUrl = await fetchImageAsDataUri(rep.photoUrl); })(),
    (async () => { rep.signatureUrl = await fetchImageAsDataUri(rep.signatureUrl); })(),
  ]);
  return payload;
}

/* ------------------------------------------------------------------- render */

async function renderPdf(browser, payload) {
  const html = await fs.readFile(path.resolve(TEMPLATE), "utf8");
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "networkidle" });
    await page.evaluate((data) => window.renderInvoice(data), payload);
    await page.evaluate(() => document.fonts.ready); // avoids fallback-font PDFs
    await page.waitForTimeout(250); // let remote product images settle
    return await page.pdf({ format: "A4", printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
  } finally {
    await page.close();
  }
}

/* ------------------------------------------------------------------- attach */

async function uploadPdf(buffer, filename) {
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: "application/pdf" }), filename);
  form.append("folderPath", "/invoices"); // folderPath or folderId, never both
  form.append("options", JSON.stringify({ access: "PUBLIC_NOT_INDEXABLE", overwrite: true }));
  return hs("/files/v3/files", { method: "POST", body: form });
}

// Association types vary by portal: some object pairs have a "default" type,
// some only have explicit typeIds, and some have none at all. Resolve once,
// then reuse.
const assocTypeCache = new Map();

async function resolveAssocType(toType) {
  if (assocTypeCache.has(toType)) return assocTypeCache.get(toType);
  const res = await hsTry(`/crm/v4/associations/notes/${toType}/labels`);
  const typeId = res.ok ? res.data?.results?.[0]?.typeId ?? null : null;
  assocTypeCache.set(toType, typeId);
  return typeId;
}

async function associateNote(noteId, toType, toId) {
  if (!toId) return false;

  // Preferred: the default association endpoint, no typeId needed.
  const asDefault = await hsTry(`/crm/v4/objects/notes/${noteId}/associations/default/${toType}/${toId}`, {
    method: "PUT",
  });
  if (asDefault.ok) return true;

  // Fallback: an explicit typeId, if the portal defines one for this pair.
  const typeId = await resolveAssocType(toType);
  if (typeId === null) {
    console.warn(`  ↳ no association type between notes and ${toType}; skipping`);
    return false;
  }

  const typed = await hsTry(`/crm/v4/objects/notes/${noteId}/associations/${toType}/${toId}`, {
    method: "PUT",
    body: JSON.stringify([{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: typeId }]),
  });
  if (!typed.ok) console.warn(`  ↳ ${toType} association failed: ${typed.error}`);
  return typed.ok;
}

async function attachNote({ fileId, invoiceId, dealId, contactId, invoiceNumber }) {
  const note = await hs("/crm/v3/objects/notes", {
    method: "POST",
    body: JSON.stringify({
      properties: {
        hs_timestamp: Date.now(),
        hs_note_body: `Branded commercial invoice ${invoiceNumber} generated.`,
        hs_attachment_ids: String(fileId),
      },
    }),
  });

  // Attach wherever the portal allows. None of these are fatal: the PDF is
  // always reachable through branded_pdf_url on the invoice.
  const attached = [];
  for (const [type, id] of [["invoices", invoiceId], ["deals", dealId], ["contacts", contactId]]) {
    if (await associateNote(note.id, type, id)) attached.push(type);
  }

  if (!attached.length) {
    console.warn(`  ↳ note ${note.id} created but associated to nothing`);
  }
  return { noteId: note.id, attached };
}

// Surface the PDF on the deal record: mirror the URL onto a deal property and
// pin the note so it sits at the top of the deal timeline as a card.
async function surfaceOnDeal({ dealId, noteId, fileUrl, invoiceId }) {
  if (!dealId) return;

  const properties = { branded_pdf_url: fileUrl };
  // Pinning only works if the note is actually associated to the deal.
  if (noteId) properties.hs_pinned_engagement_id = String(noteId);

  const res = await hsTry(`/crm/v3/objects/deals/${dealId}`, {
    method: "PATCH",
    body: JSON.stringify({ properties }),
  });
  if (!res.ok) console.warn(`  ↳ deal ${dealId} update failed: ${res.error}`);
  return res.ok;
}

/* ------------------------------------------------------------------ process */

async function processOne(browser, invoice) {
  const id = invoice.id;
  const hsNumber = invoice.properties.hs_number || id;

  // Claim it first, so a slow render plus the next poll can't double-generate.
  await setInvoice(id, { branded_pdf_status: STATUS.idle });

  const payload = await embedImages(await buildPayload(invoice));
  const number = payload.invoice.number || hsNumber;
  const pdf = await renderPdf(browser, payload);
  const file = await uploadPdf(pdf, `KELISS_Invoice_${number}.pdf`);
  const { noteId, attached } = await attachNote({
    fileId: file.id,
    invoiceId: id,
    dealId: payload.dealId,
    contactId: payload.contactId,
    invoiceNumber: number,
  });

  await surfaceOnDeal({
    dealId: payload.dealId,
    noteId: attached.includes("deals") ? noteId : null,
    fileUrl: file.url,
    invoiceId: id,
  });

  await setInvoice(id, {
    branded_pdf_status: STATUS.done,
    // Issue once, then always read back — never renumber (spec p.11).
    ...(payload.issuedNumber ? { keliss_invoice_number: payload.issuedNumber } : {}),
    branded_pdf_url: file.url,
    branded_pdf_generated_at: new Date().setUTCHours(0, 0, 0, 0),
    branded_pdf_error: "",
  });
  console.log(`✓ ${number} → ${file.url}${attached.length ? ` (note on ${attached.join(", ")})` : ""}`);
}


/* -------------------------------------------------------------------- queue */

let browser = null;

const stats = {
  startedAt: Date.now(),
  lastWebhookAt: null,
  lastReconcileAt: null,
  webhooksAccepted: 0,
  webhooksRejected: 0,
  generated: 0,
  skipped: 0,
  errors: 0,
};

// One entry per invoice id, insertion order = processing order. A second
// event for an id already waiting only upgrades its reason; a second event
// for an id currently rendering re-queues it, and the fresh read in handle()
// decides whether there is anything left to do.
const REASON_RANK = { reconcile: 0, created: 1, finalised: 2, manual: 3 };
const queue = new Map();
let inFlight = null;
let draining = null;

function enqueue(id, reason) {
  const prev = queue.get(id);
  if (!prev || REASON_RANK[reason] > REASON_RANK[prev]) queue.set(id, reason);
  drain();
}

function drain() {
  if (draining) return draining;
  draining = (async () => {
    while (queue.size) {
      const [id, reason] = queue.entries().next().value;
      queue.delete(id);
      inFlight = id;
      try {
        await handle(id, reason);
      } catch (err) {
        console.error(`✗ ${id}`, err.message);
      } finally {
        inFlight = null;
      }
    }
  })().finally(() => { draining = null; });
  return draining;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const readInvoice = (id) =>
  hsTry(`/crm/v3/objects/invoices/${id}?properties=${INVOICE_PROPS.join(",")}`);

/**
 * Decide on a fresh copy of the record, never on the webhook payload. A
 * duplicate delivery, a retry from HubSpot's 24-hour window, a reconcile hit
 * for a record the webhook already handled — they all fall out here.
 */
function decide(p, reason) {
  if (p.branded_pdf_status === STATUS.queued) return { go: true, why: "flagged Generate" };
  if (!AUTO_ON_FINALISE) return { go: false, why: "not flagged Generate (AUTO_ON_FINALISE=false)" };
  if (p.hs_invoice_status !== "open") return { go: false, why: `status is ${p.hs_invoice_status || "empty"}, not open` };
  if (p.branded_pdf_url) return { go: false, why: "already has a branded PDF" };
  if (p.branded_pdf_status === STATUS.done) return { go: false, why: "already Generated" };
  if (p.branded_pdf_status === STATUS.error) return { go: false, why: "last attempt errored — set Generate to retry" };
  return { go: true, why: reason === "reconcile" ? "finalised, no PDF yet (reconcile)" : "finalised" };
}

async function handle(id, reason) {
  // The finalise event can land a beat before HubSpot has finished writing
  // the record it describes. Give it a moment before reading.
  if (reason === "finalised" || reason === "created") await sleep(SETTLE_MS);

  let got = await readInvoice(id);
  if (!got.ok) {
    // HubSpot's "Test" button sends a sample objectId; deleted records 404 too.
    console.warn(`· ${id} skipped — ${got.error}`);
    stats.skipped++;
    return;
  }

  // Finalising assigns hs_number; if we read before that landed, read again.
  let p = got.data.properties;
  if (p.hs_invoice_status === "open" && (!p.hs_number || /draft/i.test(p.hs_number))) {
    await sleep(5000);
    got = await readInvoice(id);
    if (got.ok) p = got.data.properties;
  }

  const verdict = decide(p, reason);
  const label = p.hs_number || id;
  if (!verdict.go) {
    console.log(`· ${label} skipped — ${verdict.why}`);
    stats.skipped++;
    return;
  }

  console.log(`▶ ${label} (${verdict.why})`);
  try {
    await processOne(browser, got.data);
    stats.generated++;
  } catch (err) {
    stats.errors++;
    console.error(`✗ ${label}`, err.message);
    await setInvoice(id, {
      branded_pdf_status: STATUS.error,
      branded_pdf_error: String(err.message).slice(0, 250),
    }).catch(() => {});
  }
}

/* ------------------------------------------------------------------ webhook */

const INVOICE_TYPE_ID = "0-53";

/**
 * Which events start a render. Subscriptions to create on the private app
 * (object type Invoice):
 *   Property changed · branded_pdf_status   → manual (re)generate
 *   Property changed · hs_invoice_status    → auto-generate on finalise
 *   Created                                 → optional; only matters if an
 *                                             integration creates invoices already finalised
 * Everything else, including our own status write-backs, is ignored.
 */
function triggerFor(ev) {
  const type = String(ev.subscriptionType || "");
  if (ev.objectTypeId && ev.objectTypeId !== INVOICE_TYPE_ID) return null;
  if (!ev.objectTypeId && !type.startsWith("invoice.") && !type.startsWith("object.")) return null;

  if (type.endsWith(".propertyChange")) {
    if (ev.propertyName === "branded_pdf_status") return ev.propertyValue === STATUS.queued ? "manual" : null;
    if (ev.propertyName === "hs_invoice_status") return AUTO_ON_FINALISE && ev.propertyValue === "open" ? "finalised" : null;
    return null;
  }
  if (type.endsWith(".creation")) return AUTO_ON_FINALISE ? "created" : null;
  return null;
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * X-HubSpot-Signature-v3 = base64(HMAC-SHA256(method + uri + body + timestamp))
 * keyed with the private app's client secret, timestamp no older than five
 * minutes. `uri` is the target URL exactly as HubSpot has it, so behind a
 * tunnel or a proxy set WEBHOOK_URL rather than trusting the Host header.
 */
function verifySignature(req, rawBody) {
  if (!CLIENT_SECRET) return { ok: true, why: "unsigned (ALLOW_UNSIGNED_WEBHOOKS=1)" };

  const signature = req.headers["x-hubspot-signature-v3"];
  const timestamp = req.headers["x-hubspot-request-timestamp"];
  if (!signature || !timestamp) return { ok: false, why: "missing v3 signature headers" };
  if (Math.abs(Date.now() - Number(timestamp)) > 5 * 60 * 1000) return { ok: false, why: "timestamp older than 5 minutes" };

  const uri = (WEBHOOK_URL || `${req.headers["x-forwarded-proto"] || "https"}://${req.headers.host}${req.url}`)
    .replace(/%(3A|2F|3F|40|21|24|27|28|29|2A|2C|3B)/gi, (m) => decodeURIComponent(m));
  const expected = crypto
    .createHmac("sha256", CLIENT_SECRET)
    .update(`${req.method}${uri}${rawBody}${timestamp}`)
    .digest("base64");

  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b)
    ? { ok: true }
    : { ok: false, why: "signature mismatch (wrong HS_CLIENT_SECRET, or WEBHOOK_URL ≠ the URL in HubSpot)" };
}

async function handleWebhook(req, res) {
  const raw = await readBody(req);

  const sig = verifySignature(req, raw);
  if (!sig.ok) {
    stats.webhooksRejected++;
    console.warn(`⇐ webhook rejected: ${sig.why}`);
    res.writeHead(401);
    res.end();
    return;
  }

  let events;
  try {
    events = JSON.parse(raw);
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  if (!Array.isArray(events)) events = [events];

  // Acknowledge before doing any work: HubSpot times out at 5 s and retries.
  res.writeHead(204);
  res.end();

  stats.webhooksAccepted++;
  stats.lastWebhookAt = Date.now();
  let queued = 0;
  for (const ev of events) {
    const reason = triggerFor(ev);
    if (reason && ev.objectId !== undefined && ev.objectId !== null) {
      enqueue(String(ev.objectId), reason);
      queued++;
    }
  }
  console.log(`⇐ webhook: ${events.length} event(s), ${queued} queued${sig.why ? ` [${sig.why}]` : ""}`);
}

function health() {
  const now = Date.now();
  const reconcileStale =
    RECONCILE_MS > 0 && now - (stats.lastReconcileAt || stats.startedAt) > 3 * RECONCILE_MS;
  return {
    ok: !reconcileStale,
    uptimeSec: Math.round((now - stats.startedAt) / 1000),
    queue: queue.size,
    inFlight,
    autoOnFinalise: AUTO_ON_FINALISE,
    autoSince: new Date(AUTO_SINCE_MS).toISOString(),
    reconcileMs: RECONCILE_MS,
    ...stats,
  };
}

function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, "http://localhost");
      if (req.method === "POST" && pathname === WEBHOOK_PATH) return await handleWebhook(req, res);
      if (req.method === "GET" && (pathname === "/healthz" || pathname === "/")) {
        const body = health();
        res.writeHead(body.ok ? 200 : 503, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
        return;
      }
      res.writeHead(404);
      res.end();
    } catch (err) {
      console.error("http:", err.message);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
}

/* ---------------------------------------------------------------- reconcile */

/**
 * Safety net, not the trigger. One search every RECONCILE_MS picks up
 * anything a webhook delivery missed: the manual flag on any invoice, plus
 * (when auto-generating) invoices finalised since AUTO_SINCE that have no
 * PDF and did not error. Two groups for the auto case because a record with
 * an empty branded_pdf_status is not matched by IN / NOT_IN.
 */
async function reconcile() {
  const filterGroups = [
    { filters: [{ propertyName: "branded_pdf_status", operator: "EQ", value: STATUS.queued }] },
  ];
  if (AUTO_ON_FINALISE) {
    const open = [
      { propertyName: "hs_invoice_status", operator: "EQ", value: "open" },
      { propertyName: "branded_pdf_url", operator: "NOT_HAS_PROPERTY" },
      { propertyName: "hs_createdate", operator: "GTE", value: String(AUTO_SINCE_MS) },
    ];
    filterGroups.push({ filters: [...open, { propertyName: "branded_pdf_status", operator: "NOT_HAS_PROPERTY" }] });
    filterGroups.push({ filters: [...open, { propertyName: "branded_pdf_status", operator: "IN", values: [STATUS.idle, STATUS.queued] }] });
  }

  const res = await hs("/crm/v3/objects/invoices/search", {
    method: "POST",
    body: JSON.stringify({
      filterGroups,
      properties: ["hs_number", "branded_pdf_status"],
      sorts: [{ propertyName: "hs_lastmodifieddate", direction: "ASCENDING" }],
      limit: 20,
    }),
  });

  const results = res.results || [];
  for (const r of results) {
    enqueue(String(r.id), r.properties.branded_pdf_status === STATUS.queued ? "manual" : "reconcile");
  }
  stats.lastReconcileAt = Date.now();
  if (results.length) console.log(`↻ reconcile: ${results.length} invoice(s) queued`);
}

/* --------------------------------------------------------------------- boot */

(async () => {
  if (!TOKEN) throw new Error("HS_TOKEN missing");
  if (!CLIENT_SECRET && !ALLOW_UNSIGNED) {
    throw new Error(
      "HS_CLIENT_SECRET missing — copy it from the private app's Auth tab (Show secret). " +
      "For local testing only, ALLOW_UNSIGNED_WEBHOOKS=1 skips signature checks.");
  }
  if (Number.isNaN(AUTO_SINCE_MS)) throw new Error(`AUTO_SINCE is not a date: ${process.env.AUTO_SINCE}`);

  browser = await chromium.launch();

  const server = createServer().listen(PORT, () => {
    console.log(`Listening on :${PORT} — POST ${WEBHOOK_PATH} for HubSpot, GET /healthz for monitoring`);
    if (!CLIENT_SECRET) console.warn("⚠ webhook signatures are NOT being verified (ALLOW_UNSIGNED_WEBHOOKS=1)");
    console.log(AUTO_ON_FINALISE
      ? `Auto-generate on finalise: on (reconcile ignores invoices created before ${new Date(AUTO_SINCE_MS).toISOString()})`
      : "Auto-generate on finalise: off — only Branded PDF = Generate triggers a render");
    console.log(RECONCILE_MS > 0 ? `Reconcile search every ${RECONCILE_MS}ms` : "Reconcile search disabled");
  });

  let stopping = false;
  if (RECONCILE_MS > 0) {
    (async () => {
      while (!stopping) {
        await reconcile().catch((e) => console.error("reconcile failed:", e.message));
        await sleep(RECONCILE_MS);
      }
    })();
  }

  const stop = async () => {
    if (stopping) return;
    stopping = true;
    console.log("Stopping — finishing the invoice in progress…");
    server.close();
    // Let the current render finish so no invoice is left claimed but empty.
    await Promise.race([draining || Promise.resolve(), sleep(90_000)]);
    await browser.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
