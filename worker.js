/**
 * KELISS branded invoice worker
 *
 * Polls HubSpot for invoices flagged "Generate", renders the branded PDF from
 * invoice-template.html, uploads it to the Files API and attaches it to the
 * invoice and its deal as a note.
 *
 *   npm i playwright dotenv
 *   npx playwright install chromium
 *   node worker.js
 *
 * .env
 *   HS_TOKEN=pat-na1-...
 *   POLL_MS=30000
 *   TEMPLATE=./invoice-template.html
 */

require("dotenv").config();
const fs = require("fs/promises");
const path = require("path");
const { chromium } = require("playwright");

const API = "https://api.hubapi.com";
const TOKEN = process.env.HS_TOKEN;
const POLL_MS = Number(process.env.POLL_MS || 30000);
const TEMPLATE = process.env.TEMPLATE || "./invoice-template.html";

// Adjust these to the internal names your portal actually reports from
//   GET /crm/v3/properties/invoices
const CONFIG = require("./config.js");
const REPS = require("./reps.json");

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

const findQueued = () =>
  hs("/crm/v3/objects/invoices/search", {
    method: "POST",
    body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName: "branded_pdf_status", operator: "EQ", value: STATUS.queued }] }],
      properties: INVOICE_PROPS,
      sorts: [{ propertyName: "hs_lastmodifieddate", direction: "ASCENDING" }],
      limit: 10,
    }),
  }).then((r) => r.results || []);

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
      if (/^(\.{3}|…|et encore|and more)/i.test(text)) continue; // "…and more" filler
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

function formatDate(value, timeZone, opts) {
  const ms = toMs(value);
  if (ms === null) return null;
  return new Intl.DateTimeFormat("en-GB", {
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

const STATE_LABELS = {
  draft: "DRAFT",
  awaiting: "AWAITING PAYMENT",
  part_paid: "PART PAID",
  paid: "PAID",
  voided: "VOID",
};

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
  // hs_subtotal is the sum of line amounts (line discounts already applied);
  // hs_discounts_total is the invoice-level discount taken off after it.
  const round2 = (v) => Math.round(v * 100) / 100;
  const gross = num(p.hs_subtotal) || 0;
  const discounts = num(p.hs_discounts_total) || 0;
  const subtotal = round2(gross - discounts);
  const fees = num(p.hs_fees_total) || 0;
  const taxes = num(p.hs_taxes_total) || 0;
  const billed = num(p.hs_amount_billed) || 0;
  const balance = num(p.hs_balance_due) ?? billed;

  // Spec: total must equal subtotal − discount + fees + tax, otherwise stop.
  const expected = round2(subtotal + fees + taxes);
  if (billed && Math.abs(expected - billed) > 0.01) {
    throw new Error(`Totals do not reconcile: subtotal ${gross} − discount ${discounts} + fees ${fees} + tax ${taxes} = ${expected} but amount billed=${billed}`);
  }

  const currency = p.hs_currency || "EUR";
  const bank = CONFIG.bankAccounts[currency];
  if (!bank) throw new Error(`No bank account configured for ${currency} — cannot issue this invoice`);

  const incoterm = CONFIG.incoterms[p.keliss_incoterm] || null;
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
    // Written back to keliss_invoice_number when it was issued on this run.
    issuedNumber: p.keliss_invoice_number ? null : invoiceNumber,

    invoice: {
      number: invoiceNumber,
      documentType: p.keliss_document_type || "Commercial invoice",
      state,
      statusLabel: STATE_LABELS[state],
      currency,
      currencyLabel: CURRENCY_LABELS[currency] || currency,
      numberLocale: p.hs_locale || "en-IE",
      issuedAtLabel: formatDate(p.hs_invoice_date, tz),
      dueAtLabel: formatDate(p.hs_due_date, tz),
      // Spec p.10: "4 Sep 2026" — en-GB abbreviates September as "Sept".
      signatureDateLabel: formatDate(p.hs_invoice_date, tz, { month: "short" })?.replace(/\bSept\b/, "Sep").toUpperCase(),
      incotermLabel: incoterm?.label || p.keliss_incoterm || null,
      destination: p.keliss_destination ||
        [company.city || contact.city, company.country || contact.country].filter(Boolean).join(", ") || null,
      leadTimeLabel: leadDays ? `${leadDays} days from payment` : null,
      paymentTerms: termDays === null ? null : termDays <= 0 ? "Due on receipt" : `Net ${termDays} days`,
      payLink: p.hs_invoice_link || null,
      allowPartial: p.hs_allow_partial_payments === "true",
      cardBrands,
      howToPay: cardBrands.length
        ? `Card online using the button above, or SWIFT transfer to the account shown.`
        : "SWIFT transfer to the account shown.",
      deliveryNote: incoterm?.delivery || null,
      dispatchNote: leadDays
        ? `Goods ship within ${leadDays} days of cleared payment.`
        : "Goods ship once payment has cleared.",
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
      policyLine: `Ordering from ${CONFIG.brand.name} accepts the terms of our delivery policy at ${CONFIG.brand.deliveryPolicyUrl}.`,
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

/* --------------------------------------------------------------------- loop */

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

async function tick(browser) {
  const queued = await findQueued();
  for (const invoice of queued) {
    try {
      await processOne(browser, invoice);
    } catch (err) {
      console.error(`✗ ${invoice.id}`, err.message);
      await setInvoice(invoice.id, {
        branded_pdf_status: STATUS.error,
        branded_pdf_error: String(err.message).slice(0, 250),
      }).catch(() => {});
    }
  }
}

(async () => {
  if (!TOKEN) throw new Error("HS_TOKEN missing");
  const browser = await chromium.launch();
  const stop = async () => {
    await browser.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  console.log(`Polling every ${POLL_MS}ms…`);
  for (;;) {
    await tick(browser).catch((e) => console.error("poll failed:", e.message));
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
})();