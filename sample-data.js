// Sample payloads for offline template work. Shared by preview.js.
// module.exports(stress) → a full renderInvoice() payload.

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

module.exports = function sample(stress) {
  return {
    dealId: null,
    invoice: {
      number: "KLS-500001", status: "awaiting payment",
      issuedAt: "2026-09-04", dueAt: "2026-09-14", currency: "EUR",
      incoterms: "DDP — duty paid",
      destination: stress
        ? "Saint-Jean-de-la-Ruelle, Centre-Val de Loire, France"
        : "Villemandeur, France",
      leadTime: "12 days from payment", paymentTerms: "Net 10 days",
    },
    billTo: {
      name: stress ? "Marie-Christine de la Fontaine-Roubaix" : "Philippe Amar",
      email: "amar.philippe@hotmail.fr",
      lines: stress
        ? ["Résidence Les Grands Chênes, Bâtiment C, Appartement 214",
           "25 Rue Ambroise Paré", "45700 Villemandeur", "Centre-Val de Loire, France"]
        : ["25 Rue Ambroise Paré", "45700 Villemandeur", "Centre-Val de Loire, France"],
    },
    items: stress ? [aussieLux, flexaPro, aussieMax] : [aussieLux],
  };
};
