/**
 * Company settings — spec §"What lives in company settings".
 *
 * Admin-edited, never typed by sales, never fetched from HubSpot. Keeping this
 * in code rather than in the CRM saves an API call per render and keeps the
 * approved wording under version control.
 */

module.exports = {
  brand: {
    code: "KLS", // FLV reserved for Fluvia IQ
    name: "KELISS",
    legalName: "Foshan CaptaiNext Technology Co., Ltd",
    // White logo. Base64 it for production so the render never waits on a URL.
    logoUrl: null,
    site: "keliss.com",
    deliveryPolicyUrl: "keliss.com/delivery-policy",
  },

  seller: {
    name: "Foshan CaptaiNext Technology Co., Ltd",
    // CONFIRM BEFORE GO-LIVE: spec p.14 says the office moved to T1-1006.
    lines: [
      "No. 1204E, T12, Smart New City",
      "Jihua 1st Road, Zhangcha Street, Chancheng District",
      "Foshan, Guangdong 510168, China",
    ],
    registrationNo: "9144 0600 MA52 U9BU 1L",
  },

  legalLine:
    "KELISS™ is a registered trademark of CaptaiNext Group — USA 97567688 · European Union 018770909 · " +
    "Tax ID (DE) 16/181/35901. Foshan CaptaiNext Technology Co., Ltd, Reg. No. 9144 0600 MA52 U9BU 1L. " +
    "This document is issued electronically and is valid without a wet signature.",

  /**
   * One entry per currency. A currency with no entry is a hard stop — the
   * generator must not print an invoice the buyer cannot pay.
   *
   * EUR, USD and AUD are all settled through the same multi-currency account,
   * so they share one entry. A currency with its own account gets its own
   * object here rather than a reference to this one.
   */
  bankAccounts: (() => {
    const captainextHongKong = {
      accountName: "CAPTAINEXT GROUP LIMITED",
      accountNumber: "63001410482",
      bank: "JPMorgan Chase Bank N.A., Hong Kong Branch",
      address: "Chater House, 8 Connaught Road, Central, Hong Kong",
      swift: "CHASHKHH (CHASHKHHXXX)",
      routing: "007863 · Bank 007 · Branch 863",
      // Prints in the bank box, so the buyer can see the account takes their currency.
      currencies: "EUR € · USD $ · AUD A$",
    };
    return {
      EUR: captainextHongKong,
      USD: captainextHongKong,
      AUD: captainextHongKong,
    };
  })(),

  /**
   * One approved paragraph per incoterm. `label` prints in the trade-terms box,
   * `delivery` in the payment and delivery notes.
   */
  incoterms: {
    EXW: {
      label: "EXW — ex works",
      delivery:
        "Collection from our Foshan facility. Export clearance, freight, import duties and delivery are arranged and paid by the buyer.",
    },
    FOB: {
      label: "FOB — free on board",
      delivery:
        "Delivered on board at the named port of shipment. Ocean freight, insurance, import duties and inland delivery are the buyer's responsibility.",
    },
    CIF: {
      label: "CIF — cost, insurance and freight",
      delivery:
        "Ocean freight and insurance to the named destination port are included. Import duties, customs clearance and onward delivery are paid by the buyer.",
    },
    DAP: {
      label: "DAP — delivered at place",
      delivery:
        "Delivered to the address shown. Import duties and customs clearance are payable by the buyer on arrival.",
    },
    DDP: {
      label: "DDP — duty paid",
      delivery:
        "Door-to-door under DDP terms. Import duties, customs clearance and delivery charges are included in the price.",
    },
  },

  cardBrandLabels: {
    credit_or_debit_card: "Visa · Mastercard · Amex",
    ach: "ACH",
    sepa: "SEPA",
    bacs: "BACS",
    pads: "PADS",
  },
};