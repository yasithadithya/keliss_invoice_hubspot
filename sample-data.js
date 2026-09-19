// Sample payloads for offline template work. Shared by preview.js.
// module.exports(stress, lang) → a full renderInvoice() payload.
//
// The strings block is built by i18n.js, exactly as the worker builds it, so
// the preview shows the same wording a real invoice in that language would.

const i18n = require("./i18n.js");
const CONFIG = require("./config.js");

const aussieLux = {
  name: "AussieLux Deluxe",
  sku: "S005",
  description: "Wall-hung luxury smart toilet",
  imageUrl: "https://placehold.co/600x600/png",
  features: [
    "Proximity sensor", "Booster-pump flushing", "Automatic lid operation",
    "Infrared therapy nozzle", "Laser foot sensor", "Multiple cleansing modes",
    "Automatic flush", "Instant water heating", "Remote and manual control",
    "Ambient lighting", "Automatic UV sterilisation", "Anti-splash bubble foam",
    "Integrated water tank", "HD LED display",
  ],
  packNote: "Reinforced wall-mounting frame included in the pack",
  qty: 3, unitPrice: 627, listPrice: 660, savePerUnit: 33, amount: 1881,
};

// No listPrice → discount row + YOU SAVED strip hide. No imageUrl → placeholder cell.
const flexaPro = {
  name: "FlexaPro Compact",
  sku: "S003W",
  description: "Space-saving smart bidet seat",
  imageUrl: null,
  features: ["Warm-water wash", "Heated seat", "Soft-close lid", "Eco standby"],
  packNote: "",
  qty: 1, unitPrice: 280, listPrice: null, savePerUnit: 0, amount: 280,
};

const aussieMax = {
  name: "AussieMax Grande",
  sku: "G1FD-E",
  description: "Floor-standing smart toilet with tank",
  imageUrl: "https://placehold.co/600x600/png",
  features: ["Auto open/close", "Night light", "Deodoriser", "Dryer", "Seat sensor", "Kids mode"],
  packNote: "Ships with ceramic P-trap adapter",
  qty: 2, unitPrice: 415, listPrice: 450, savePerUnit: 35, amount: 830,
};

// state: awaiting (default) · part_paid · paid · nolink (awaiting, no HubSpot pay link)
module.exports = function sample(stress, lang = "en", state = "awaiting") {
  const L = i18n.resolve(lang, null);
  const S = i18n.dictionary(L.lang);
  const incoterm = S.incoterms?.DDP;

  const data = {
    dealId: null,
    i18n: { lang: L.lang, locale: L.locale, strings: S },
    invoice: {
      number: "KLS-500001",
      documentType: S.documentType,
      state: "awaiting",
      statusLabel: S.status.awaiting,
      currency: "EUR", currencyLabel: "EUR €", numberLocale: L.locale,
      issuedAtLabel: new Intl.DateTimeFormat(L.dateLocale,
        { day: "numeric", month: "long", year: "numeric" }).format(new Date("2026-09-04")),
      dueAtLabel: new Intl.DateTimeFormat(L.dateLocale,
        { day: "numeric", month: "long", year: "numeric" }).format(new Date("2026-09-14")),
      signatureDateLabel: i18n.signatureDate(new Intl.DateTimeFormat(L.dateLocale,
        { day: "numeric", month: "short", year: "numeric" }).format(new Date("2026-09-04")), L.lang),
      incotermLabel: incoterm?.label || "DDP — duty paid",
      destination: stress
        ? "Saint-Jean-de-la-Ruelle, Centre-Val de Loire, France"
        : "Villemandeur, France",
      leadTimeLabel: i18n.fmt(S.notes.leadTime, { days: 12 }),
      paymentTerms: i18n.fmt(S.notes.netDays, { days: 10 }),
      payLink: "https://app.hubspot.com/payments/sample",
      allowPartial: false,
      cardBrands: ["Visa · Mastercard · Amex"],
      howToPay: S.notes.howToPayCard,
      deliveryNote: incoterm?.delivery ||
        "Door-to-door under DDP terms. Import duties, customs clearance and delivery charges are included in the price.",
      dispatchNote: i18n.fmt(S.notes.dispatchWithLead, { days: 12 }),
      comments: null,
    },

    totals: {
      gross: stress ? 3201 : 1980, discounts: stress ? 210 : 99,
      subtotal: stress ? 2991 : 1881, fees: 0, taxes: 0,
      total: stress ? 2991 : 1881, paidToDate: 0,
      balanceDue: stress ? 2991 : 1881,
      discountPct: stress ? 7 : 5,
    },
    billTo: {
      name: stress ? "Marie-Christine de la Fontaine-Roubaix" : "Philippe Amar",
      email: "amar.philippe@hotmail.fr",
      lines: stress
        ? ["Résidence Les Grands Chênes, Bâtiment C, Appartement 214",
           "25 Rue Ambroise Paré", "45700 Villemandeur", "Centre-Val de Loire, France"]
        : ["25 Rue Ambroise Paré", "45700 Villemandeur", "Centre-Val de Loire, France"],
    },
    items: (stress ? [aussieLux, flexaPro, aussieMax] : [aussieLux]).map((it) => ({
      ...it,
      subtitle: it.description,
      features: it.features,
      note: it.packNote || null,
    })),

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

    bank: CONFIG.bankAccounts.EUR,

    rep: {
      name: "Yasith Adithya", email: "yasith@keliss.com", initials: "YA",
      title: "Export sales", phone: "+86 138 0000 0000", whatsapp: "+86 138 0000 0000",
      photoUrl: null, signatureUrl: null,
    },
  };

  const { invoice, totals } = data;
  if (state === "nolink") {
    invoice.payLink = null;
    invoice.howToPay = S.notes.howToPaySwift;
  } else if (state === "part_paid" || state === "paid") {
    invoice.state = state;
    invoice.statusLabel = S.status[state];
    totals.paidToDate = state === "paid" ? totals.total : 500;
    totals.balanceDue = totals.total - totals.paidToDate;
    if (state === "paid") invoice.howToPay = S.notes.howToPaySwift;
  }
  return data;
};
