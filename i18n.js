/**
 * Invoice localisation — spec §"Multi-currency and language".
 *
 * The buyer-facing wording of the PDF follows the Language field on the
 * HubSpot invoice (`hs_language`, e.g. "en", "fr", "pt-br"). Every string the
 * reader sees is either here or in config.js; nothing is machine-translated at
 * render time.
 *
 * Two locales come out of resolve(), and they are deliberately different:
 *
 *   locale      numbers and currency. Honours `hs_locale` ("en-us" → "en-US")
 *               when it agrees with the invoice language, so a US buyer keeps
 *               US grouping and a Brazilian buyer keeps pt-BR grouping.
 *   dateLocale  dates only. Always the language's own default, so an English
 *               invoice keeps the European "4 September 2026" the spec asks
 *               for (p.10) whatever region HubSpot happens to store.
 *
 * Adding a language is one entry in DICTIONARIES plus one in DEFAULT_LOCALES.
 * Any key left out falls back to English rather than printing blank.
 *
 * Not translated, on purpose:
 *   - config.legalLine, the seller address and the bank details — legal text
 *     and proper nouns, quoted rather than read
 *   - hs_comments, which the rep already types in the buyer's language
 *   - the English incoterm wording, which stays in config.js as the approved
 *     source; the other languages carry an `incoterms` block below
 */

const DEFAULT_LANGUAGE = "en";

const DEFAULT_LOCALES = {
  en: "en-IE",
  fr: "fr-FR",
  de: "de-DE",
  es: "es-ES",
  it: "it-IT",
  nl: "nl-NL",
  pt: "pt-PT",
};

/* ------------------------------------------------------------ dictionaries */

const DICTIONARIES = {
  en: {
    documentType: "Commercial invoice",
    status: {
      draft: "DRAFT",
      awaiting: "AWAITING PAYMENT",
      part_paid: "PART PAID",
      paid: "PAID",
      voided: "VOID",
    },
    watermark: { draft: "DRAFT", voided: "VOID" },
    header: { invoiceNo: "INVOICE NO." },
    meta: { issued: "DATE ISSUED", due: "PAYMENT DUE", currency: "CURRENCY" },
    parties: {
      seller: "SELLER",
      billTo: "BILL TO",
      attn: "Attn. {name}",
      regNo: "Reg. No. {no}",
    },
    terms: {
      incoterms: "INCOTERMS",
      destination: "DESTINATION",
      leadTime: "LEAD TIME",
      paymentTerms: "PAYMENT TERMS",
    },
    goods: {
      title: "Goods",
      titleContinued: "Goods (continued)",
      product: "PRODUCT",
      spec: "MODEL & SPECIFICATION",
      qty: "QTY",
      unitPrice: "UNIT PRICE",
      amount: "AMOUNT",
      sku: "SKU",
      noImage: "NO IMAGE",
      saveEach: "SAVE {amount} EACH",
    },
    pay: {
      title: "Pay online",
      blurbCard: "Card payment is processed securely through our HubSpot checkout.",
      blurbOnline: "Pay securely online through our HubSpot checkout.",
      partialNote: " Partial payments are accepted on this invoice.",
      payNow: "Pay {amount}",
      payRemaining: "Pay remaining {amount}",
      transferNote: "Or transfer to the bank account below, quoting invoice {number}",
      paidMark: "PAID",
      paidBlurb: "Thank you. This invoice is settled in full; no further payment is due.",
    },
    totals: {
      gross: "Gross value",
      discount: "Trade discount",
      discountPct: "Trade discount ({pct}%)",
      subtotal: "Subtotal",
      fees: "Shipping, duties & handling",
      tax: "Tax",
      paidToDate: "Paid to date",
      balanceDue: "Balance due",
      total: "TOTAL DUE",
      saved: "YOU SAVED",
      savedPct: "{pct}% off list",
    },
    bank: {
      title: "BANK TRANSFER",
      accountName: "Account name",
      accountNumber: "Account number",
      bank: "Bank",
      address: "Address",
      swift: "SWIFT / BIC",
      routing: "Routing",
      currencies: "Currencies",
    },
    delivery: {
      title: "PAYMENT & DELIVERY",
      howToPay: "How to pay.",
      delivery: "Delivery.",
      dispatch: "Dispatch.",
    },
    notes: {
      howToPayCard: "Card online using the button above, or SWIFT transfer to the account shown.",
      howToPaySwift: "SWIFT transfer to the account shown.",
      dispatchWithLead: "Goods ship within {days} days of cleared payment.",
      dispatchNoLead: "Goods ship once payment has cleared.",
      policyLine: "Ordering from {brand} accepts the terms of our delivery policy at {url}.",
      leadTime: "{days} days from payment",
      dueOnReceipt: "Due on receipt",
      netDays: "Net {days} days",
    },
    signature: { authorised: "AUTHORISED SIGNATURE" },
    page: { invoice: "INVOICE", pageOf: "PAGE {page} OF {pages}" },
    // English incoterm wording lives in config.js — see the header note.
  },

  fr: {
    documentType: "Facture commerciale",
    status: {
      draft: "BROUILLON",
      awaiting: "EN ATTENTE DE PAIEMENT",
      part_paid: "PARTIELLEMENT PAYÉE",
      paid: "PAYÉE",
      voided: "ANNULÉE",
    },
    watermark: { draft: "BROUILLON", voided: "ANNULÉE" },
    header: { invoiceNo: "FACTURE N°" },
    meta: { issued: "DATE D'ÉMISSION", due: "ÉCHÉANCE", currency: "DEVISE" },
    parties: {
      seller: "VENDEUR",
      billTo: "FACTURER À",
      attn: "À l'attention de {name}",
      regNo: "N° d'enregistrement {no}",
    },
    terms: {
      incoterms: "INCOTERMS",
      destination: "DESTINATION",
      leadTime: "DÉLAI DE LIVRAISON",
      paymentTerms: "CONDITIONS DE PAIEMENT",
    },
    goods: {
      title: "Marchandises",
      titleContinued: "Marchandises (suite)",
      product: "PRODUIT",
      spec: "MODÈLE ET SPÉCIFICATIONS",
      qty: "QTÉ",
      unitPrice: "PRIX UNITAIRE",
      amount: "MONTANT",
      sku: "RÉF.",
      noImage: "PAS D'IMAGE",
      saveEach: "ÉCONOMISEZ {amount} PAR UNITÉ",
    },
    pay: {
      title: "Payer en ligne",
      blurbCard: "Le paiement par carte est traité en toute sécurité via notre page de paiement HubSpot.",
      blurbOnline: "Payez en ligne en toute sécurité via notre page de paiement HubSpot.",
      partialNote: " Les paiements partiels sont acceptés sur cette facture.",
      payNow: "Payer {amount}",
      payRemaining: "Payer le solde {amount}",
      transferNote: "Ou effectuez un virement sur le compte bancaire ci-dessous en indiquant la facture {number}",
      paidMark: "PAYÉE",
      paidBlurb: "Merci. Cette facture est intégralement réglée ; aucun paiement supplémentaire n'est dû.",
    },
    totals: {
      gross: "Montant brut",
      discount: "Remise commerciale",
      discountPct: "Remise commerciale ({pct} %)",
      subtotal: "Sous-total",
      fees: "Transport, droits et manutention",
      tax: "Taxes",
      paidToDate: "Déjà payé",
      balanceDue: "Solde dû",
      total: "TOTAL À PAYER",
      saved: "VOUS ÉCONOMISEZ",
      savedPct: "{pct} % de remise",
    },
    bank: {
      title: "VIREMENT BANCAIRE",
      accountName: "Titulaire du compte",
      accountNumber: "Numéro de compte",
      bank: "Banque",
      address: "Adresse",
      swift: "SWIFT / BIC",
      routing: "Code guichet",
      currencies: "Devises",
    },
    delivery: {
      title: "PAIEMENT ET LIVRAISON",
      howToPay: "Comment payer.",
      delivery: "Livraison.",
      dispatch: "Expédition.",
    },
    notes: {
      howToPayCard: "Par carte en ligne via le bouton ci-dessus, ou par virement SWIFT sur le compte indiqué.",
      howToPaySwift: "Par virement SWIFT sur le compte indiqué.",
      dispatchWithLead: "Les marchandises sont expédiées sous {days} jours après encaissement du paiement.",
      dispatchNoLead: "Les marchandises sont expédiées dès l'encaissement du paiement.",
      policyLine: "Toute commande passée auprès de {brand} vaut acceptation des conditions de notre politique de livraison disponible sur {url}.",
      leadTime: "{days} jours après paiement",
      dueOnReceipt: "Payable à réception",
      netDays: "Net {days} jours",
    },
    signature: { authorised: "SIGNATURE AUTORISÉE" },
    page: { invoice: "FACTURE", pageOf: "PAGE {page} SUR {pages}" },
    incoterms: {
      EXW: {
        label: "EXW — départ usine",
        delivery:
          "Enlèvement dans notre usine de Foshan. Les formalités d'exportation, le fret, les droits d'importation et la livraison sont organisés et payés par l'acheteur.",
      },
      FOB: {
        label: "FOB — franco à bord",
        delivery:
          "Livraison à bord au port d'embarquement convenu. Le fret maritime, l'assurance, les droits d'importation et l'acheminement terrestre sont à la charge de l'acheteur.",
      },
      CIF: {
        label: "CIF — coût, assurance et fret",
        delivery:
          "Le fret maritime et l'assurance jusqu'au port de destination convenu sont inclus. Les droits d'importation, le dédouanement et l'acheminement final sont à la charge de l'acheteur.",
      },
      DAP: {
        label: "DAP — rendu au lieu de destination",
        delivery:
          "Livraison à l'adresse indiquée. Les droits d'importation et le dédouanement sont à la charge de l'acheteur à l'arrivée.",
      },
      DDP: {
        label: "DDP — rendu droits acquittés",
        delivery:
          "Livraison porte-à-porte en DDP. Les droits d'importation, le dédouanement et les frais de livraison sont inclus dans le prix.",
      },
    },
  },

  de: {
    documentType: "Handelsrechnung",
    status: {
      draft: "ENTWURF",
      awaiting: "ZAHLUNG AUSSTEHEND",
      part_paid: "TEILWEISE BEZAHLT",
      paid: "BEZAHLT",
      voided: "STORNIERT",
    },
    watermark: { draft: "ENTWURF", voided: "STORNIERT" },
    header: { invoiceNo: "RECHNUNGSNR." },
    meta: { issued: "RECHNUNGSDATUM", due: "FÄLLIG AM", currency: "WÄHRUNG" },
    parties: {
      seller: "VERKÄUFER",
      billTo: "RECHNUNGSEMPFÄNGER",
      attn: "z. Hd. {name}",
      regNo: "Reg.-Nr. {no}",
    },
    terms: {
      incoterms: "INCOTERMS",
      destination: "BESTIMMUNGSORT",
      leadTime: "LIEFERZEIT",
      paymentTerms: "ZAHLUNGSBEDINGUNGEN",
    },
    goods: {
      title: "Waren",
      titleContinued: "Waren (Fortsetzung)",
      product: "PRODUKT",
      spec: "MODELL & SPEZIFIKATION",
      qty: "MENGE",
      unitPrice: "STÜCKPREIS",
      amount: "BETRAG",
      sku: "ART.-NR.",
      noImage: "KEIN BILD",
      saveEach: "{amount} SPAREN PRO STÜCK",
    },
    pay: {
      title: "Online bezahlen",
      blurbCard: "Kartenzahlungen werden sicher über unseren HubSpot-Checkout abgewickelt.",
      blurbOnline: "Bezahlen Sie sicher online über unseren HubSpot-Checkout.",
      partialNote: " Teilzahlungen sind für diese Rechnung zulässig.",
      payNow: "{amount} bezahlen",
      payRemaining: "Restbetrag {amount} bezahlen",
      transferNote: "Oder überweisen Sie auf das unten angegebene Bankkonto unter Angabe der Rechnung {number}",
      paidMark: "BEZAHLT",
      paidBlurb: "Vielen Dank. Diese Rechnung ist vollständig beglichen; es ist keine weitere Zahlung fällig.",
    },
    totals: {
      gross: "Bruttowert",
      discount: "Handelsrabatt",
      discountPct: "Handelsrabatt ({pct} %)",
      subtotal: "Zwischensumme",
      fees: "Fracht, Zölle und Bearbeitung",
      tax: "Steuer",
      paidToDate: "Bereits gezahlt",
      balanceDue: "Offener Betrag",
      total: "GESAMTBETRAG",
      saved: "SIE SPAREN",
      savedPct: "{pct} % unter Listenpreis",
    },
    bank: {
      title: "BANKÜBERWEISUNG",
      accountName: "Kontoinhaber",
      accountNumber: "Kontonummer",
      bank: "Bank",
      address: "Adresse",
      swift: "SWIFT / BIC",
      routing: "Bankleitzahl",
      currencies: "Währungen",
    },
    delivery: {
      title: "ZAHLUNG & LIEFERUNG",
      howToPay: "Zahlung.",
      delivery: "Lieferung.",
      dispatch: "Versand.",
    },
    notes: {
      howToPayCard: "Online per Karte über die Schaltfläche oben oder per SWIFT-Überweisung auf das angegebene Konto.",
      howToPaySwift: "Per SWIFT-Überweisung auf das angegebene Konto.",
      dispatchWithLead: "Die Ware wird innerhalb von {days} Tagen nach Zahlungseingang versandt.",
      dispatchNoLead: "Die Ware wird nach Zahlungseingang versandt.",
      policyLine: "Mit einer Bestellung bei {brand} akzeptieren Sie die Bedingungen unserer Lieferrichtlinie unter {url}.",
      leadTime: "{days} Tage ab Zahlung",
      dueOnReceipt: "Zahlbar sofort",
      netDays: "Netto {days} Tage",
    },
    signature: { authorised: "AUTORISIERTE UNTERSCHRIFT" },
    page: { invoice: "RECHNUNG", pageOf: "SEITE {page} VON {pages}" },
    incoterms: {
      EXW: {
        label: "EXW — ab Werk",
        delivery:
          "Abholung in unserem Werk in Foshan. Ausfuhrabfertigung, Fracht, Einfuhrabgaben und Zustellung organisiert und bezahlt der Käufer.",
      },
      FOB: {
        label: "FOB — frei an Bord",
        delivery:
          "Lieferung an Bord im benannten Verschiffungshafen. Seefracht, Versicherung, Einfuhrabgaben und Inlandstransport gehen zulasten des Käufers.",
      },
      CIF: {
        label: "CIF — Kosten, Versicherung und Fracht",
        delivery:
          "Seefracht und Versicherung bis zum benannten Bestimmungshafen sind enthalten. Einfuhrabgaben, Zollabfertigung und Weitertransport zahlt der Käufer.",
      },
      DAP: {
        label: "DAP — geliefert benannter Ort",
        delivery:
          "Lieferung an die angegebene Adresse. Einfuhrabgaben und Zollabfertigung sind bei Ankunft vom Käufer zu tragen.",
      },
      DDP: {
        label: "DDP — geliefert verzollt",
        delivery:
          "Lieferung frei Haus zu DDP-Bedingungen. Einfuhrabgaben, Zollabfertigung und Liefergebühren sind im Preis enthalten.",
      },
    },
  },

  es: {
    documentType: "Factura comercial",
    status: {
      draft: "BORRADOR",
      awaiting: "PENDIENTE DE PAGO",
      part_paid: "PAGADA PARCIALMENTE",
      paid: "PAGADA",
      voided: "ANULADA",
    },
    watermark: { draft: "BORRADOR", voided: "ANULADA" },
    header: { invoiceNo: "FACTURA N.º" },
    meta: { issued: "FECHA DE EMISIÓN", due: "VENCIMIENTO", currency: "MONEDA" },
    parties: {
      seller: "VENDEDOR",
      billTo: "FACTURAR A",
      attn: "A la atención de {name}",
      regNo: "N.º de registro {no}",
    },
    terms: {
      incoterms: "INCOTERMS",
      destination: "DESTINO",
      leadTime: "PLAZO DE ENTREGA",
      paymentTerms: "CONDICIONES DE PAGO",
    },
    goods: {
      title: "Mercancías",
      titleContinued: "Mercancías (continuación)",
      product: "PRODUCTO",
      spec: "MODELO Y ESPECIFICACIONES",
      qty: "CANT.",
      unitPrice: "PRECIO UNITARIO",
      amount: "IMPORTE",
      sku: "REF.",
      noImage: "SIN IMAGEN",
      saveEach: "AHORRE {amount} POR UNIDAD",
    },
    pay: {
      title: "Pagar en línea",
      blurbCard: "El pago con tarjeta se procesa de forma segura a través de nuestro checkout de HubSpot.",
      blurbOnline: "Pague en línea de forma segura a través de nuestro checkout de HubSpot.",
      partialNote: " Se aceptan pagos parciales en esta factura.",
      payNow: "Pagar {amount}",
      payRemaining: "Pagar el saldo {amount}",
      transferNote: "O realice una transferencia a la cuenta bancaria indicada abajo, citando la factura {number}",
      paidMark: "PAGADA",
      paidBlurb: "Gracias. Esta factura está totalmente liquidada; no queda ningún pago pendiente.",
    },
    totals: {
      gross: "Valor bruto",
      discount: "Descuento comercial",
      discountPct: "Descuento comercial ({pct} %)",
      subtotal: "Subtotal",
      fees: "Transporte, aranceles y gestión",
      tax: "Impuestos",
      paidToDate: "Pagado hasta la fecha",
      balanceDue: "Saldo pendiente",
      total: "TOTAL A PAGAR",
      saved: "USTED AHORRA",
      savedPct: "{pct} % sobre el precio de lista",
    },
    bank: {
      title: "TRANSFERENCIA BANCARIA",
      accountName: "Titular de la cuenta",
      accountNumber: "Número de cuenta",
      bank: "Banco",
      address: "Dirección",
      swift: "SWIFT / BIC",
      routing: "Código de ruta",
      currencies: "Monedas",
    },
    delivery: {
      title: "PAGO Y ENTREGA",
      howToPay: "Cómo pagar.",
      delivery: "Entrega.",
      dispatch: "Expedición.",
    },
    notes: {
      howToPayCard: "Con tarjeta en línea mediante el botón de arriba, o por transferencia SWIFT a la cuenta indicada.",
      howToPaySwift: "Por transferencia SWIFT a la cuenta indicada.",
      dispatchWithLead: "La mercancía se envía en un plazo de {days} días desde la confirmación del pago.",
      dispatchNoLead: "La mercancía se envía una vez confirmado el pago.",
      policyLine: "Al realizar un pedido a {brand} se aceptan las condiciones de nuestra política de entrega disponible en {url}.",
      leadTime: "{days} días desde el pago",
      dueOnReceipt: "Pagadero a la recepción",
      netDays: "Neto {days} días",
    },
    signature: { authorised: "FIRMA AUTORIZADA" },
    page: { invoice: "FACTURA", pageOf: "PÁGINA {page} DE {pages}" },
    incoterms: {
      EXW: {
        label: "EXW — en fábrica",
        delivery:
          "Recogida en nuestras instalaciones de Foshan. El despacho de exportación, el flete, los aranceles de importación y la entrega corren por cuenta del comprador.",
      },
      FOB: {
        label: "FOB — franco a bordo",
        delivery:
          "Entrega a bordo en el puerto de embarque designado. El flete marítimo, el seguro, los aranceles de importación y el transporte interior son responsabilidad del comprador.",
      },
      CIF: {
        label: "CIF — coste, seguro y flete",
        delivery:
          "El flete marítimo y el seguro hasta el puerto de destino designado están incluidos. Los aranceles de importación, el despacho de aduanas y la entrega posterior los paga el comprador.",
      },
      DAP: {
        label: "DAP — entregada en lugar",
        delivery:
          "Entrega en la dirección indicada. Los aranceles de importación y el despacho de aduanas son a cargo del comprador a la llegada.",
      },
      DDP: {
        label: "DDP — entregada derechos pagados",
        delivery:
          "Entrega puerta a puerta en condiciones DDP. Los aranceles de importación, el despacho de aduanas y los gastos de entrega están incluidos en el precio.",
      },
    },
  },

  it: {
    documentType: "Fattura commerciale",
    status: {
      draft: "BOZZA",
      awaiting: "IN ATTESA DI PAGAMENTO",
      part_paid: "PARZIALMENTE PAGATA",
      paid: "PAGATA",
      voided: "ANNULLATA",
    },
    watermark: { draft: "BOZZA", voided: "ANNULLATA" },
    header: { invoiceNo: "FATTURA N." },
    meta: { issued: "DATA DI EMISSIONE", due: "SCADENZA", currency: "VALUTA" },
    parties: {
      seller: "VENDITORE",
      billTo: "INTESTATA A",
      attn: "All'attenzione di {name}",
      regNo: "N. registrazione {no}",
    },
    terms: {
      incoterms: "INCOTERMS",
      destination: "DESTINAZIONE",
      leadTime: "TEMPI DI CONSEGNA",
      paymentTerms: "CONDIZIONI DI PAGAMENTO",
    },
    goods: {
      title: "Merci",
      titleContinued: "Merci (continua)",
      product: "PRODOTTO",
      spec: "MODELLO E SPECIFICHE",
      qty: "Q.TÀ",
      unitPrice: "PREZZO UNITARIO",
      amount: "IMPORTO",
      sku: "COD.",
      noImage: "NESSUNA IMMAGINE",
      saveEach: "RISPARMIA {amount} A PEZZO",
    },
    pay: {
      title: "Paga online",
      blurbCard: "I pagamenti con carta sono elaborati in modo sicuro tramite il nostro checkout HubSpot.",
      blurbOnline: "Paga online in modo sicuro tramite il nostro checkout HubSpot.",
      partialNote: " Su questa fattura sono ammessi pagamenti parziali.",
      payNow: "Paga {amount}",
      payRemaining: "Paga il saldo {amount}",
      transferNote: "Oppure effettua un bonifico sul conto indicato di seguito, citando la fattura {number}",
      paidMark: "PAGATA",
      paidBlurb: "Grazie. Questa fattura è saldata per intero; non è dovuto alcun ulteriore pagamento.",
    },
    totals: {
      gross: "Valore lordo",
      discount: "Sconto commerciale",
      discountPct: "Sconto commerciale ({pct} %)",
      subtotal: "Subtotale",
      fees: "Trasporto, dazi e gestione",
      tax: "Imposte",
      paidToDate: "Pagato ad oggi",
      balanceDue: "Saldo dovuto",
      total: "TOTALE DA PAGARE",
      saved: "HAI RISPARMIATO",
      savedPct: "{pct} % sul prezzo di listino",
    },
    bank: {
      title: "BONIFICO BANCARIO",
      accountName: "Intestatario del conto",
      accountNumber: "Numero di conto",
      bank: "Banca",
      address: "Indirizzo",
      swift: "SWIFT / BIC",
      routing: "Codice di instradamento",
      currencies: "Valute",
    },
    delivery: {
      title: "PAGAMENTO E CONSEGNA",
      howToPay: "Come pagare.",
      delivery: "Consegna.",
      dispatch: "Spedizione.",
    },
    notes: {
      howToPayCard: "Con carta online tramite il pulsante qui sopra, oppure con bonifico SWIFT sul conto indicato.",
      howToPaySwift: "Con bonifico SWIFT sul conto indicato.",
      dispatchWithLead: "La merce viene spedita entro {days} giorni dall'incasso del pagamento.",
      dispatchNoLead: "La merce viene spedita dopo l'incasso del pagamento.",
      policyLine: "L'invio di un ordine a {brand} comporta l'accettazione delle condizioni della nostra politica di consegna disponibile su {url}.",
      leadTime: "{days} giorni dal pagamento",
      dueOnReceipt: "Pagamento alla ricezione",
      netDays: "Netto {days} giorni",
    },
    signature: { authorised: "FIRMA AUTORIZZATA" },
    page: { invoice: "FATTURA", pageOf: "PAGINA {page} DI {pages}" },
    incoterms: {
      EXW: {
        label: "EXW — franco fabbrica",
        delivery:
          "Ritiro presso il nostro stabilimento di Foshan. Sdoganamento all'esportazione, trasporto, dazi all'importazione e consegna sono organizzati e pagati dall'acquirente.",
      },
      FOB: {
        label: "FOB — franco a bordo",
        delivery:
          "Consegna a bordo nel porto di imbarco convenuto. Nolo marittimo, assicurazione, dazi all'importazione e trasporto interno sono a carico dell'acquirente.",
      },
      CIF: {
        label: "CIF — costo, assicurazione e nolo",
        delivery:
          "Nolo marittimo e assicurazione fino al porto di destinazione convenuto sono inclusi. Dazi all'importazione, sdoganamento e consegna successiva sono a carico dell'acquirente.",
      },
      DAP: {
        label: "DAP — reso al luogo di destinazione",
        delivery:
          "Consegna all'indirizzo indicato. Dazi all'importazione e sdoganamento sono a carico dell'acquirente all'arrivo.",
      },
      DDP: {
        label: "DDP — reso sdoganato",
        delivery:
          "Consegna porta a porta in condizioni DDP. Dazi all'importazione, sdoganamento e spese di consegna sono inclusi nel prezzo.",
      },
    },
  },

  nl: {
    documentType: "Handelsfactuur",
    status: {
      draft: "CONCEPT",
      awaiting: "WACHT OP BETALING",
      part_paid: "DEELS BETAALD",
      paid: "BETAALD",
      voided: "GEANNULEERD",
    },
    watermark: { draft: "CONCEPT", voided: "GEANNULEERD" },
    header: { invoiceNo: "FACTUURNR." },
    meta: { issued: "FACTUURDATUM", due: "VERVALDATUM", currency: "VALUTA" },
    parties: {
      seller: "VERKOPER",
      billTo: "FACTUURADRES",
      attn: "T.a.v. {name}",
      regNo: "Reg.nr. {no}",
    },
    terms: {
      incoterms: "INCOTERMS",
      destination: "BESTEMMING",
      leadTime: "LEVERTIJD",
      paymentTerms: "BETALINGSVOORWAARDEN",
    },
    goods: {
      title: "Goederen",
      titleContinued: "Goederen (vervolg)",
      product: "PRODUCT",
      spec: "MODEL & SPECIFICATIE",
      qty: "AANTAL",
      unitPrice: "STUKPRIJS",
      amount: "BEDRAG",
      sku: "ART.NR.",
      noImage: "GEEN AFBEELDING",
      saveEach: "BESPAAR {amount} PER STUK",
    },
    pay: {
      title: "Online betalen",
      blurbCard: "Kaartbetalingen worden veilig verwerkt via onze HubSpot-checkout.",
      blurbOnline: "Betaal veilig online via onze HubSpot-checkout.",
      partialNote: " Deelbetalingen zijn toegestaan op deze factuur.",
      payNow: "{amount} betalen",
      payRemaining: "Restbedrag {amount} betalen",
      transferNote: "Of maak het bedrag over naar de onderstaande bankrekening onder vermelding van factuur {number}",
      paidMark: "BETAALD",
      paidBlurb: "Hartelijk dank. Deze factuur is volledig voldaan; er is geen betaling meer verschuldigd.",
    },
    totals: {
      gross: "Brutowaarde",
      discount: "Handelskorting",
      discountPct: "Handelskorting ({pct}%)",
      subtotal: "Subtotaal",
      fees: "Vracht, rechten en behandeling",
      tax: "Belasting",
      paidToDate: "Reeds betaald",
      balanceDue: "Openstaand saldo",
      total: "TOTAAL TE BETALEN",
      saved: "U BESPAART",
      savedPct: "{pct}% korting op de adviesprijs",
    },
    bank: {
      title: "BANKOVERSCHRIJVING",
      accountName: "Rekeninghouder",
      accountNumber: "Rekeningnummer",
      bank: "Bank",
      address: "Adres",
      swift: "SWIFT / BIC",
      routing: "Routingcode",
      currencies: "Valuta's",
    },
    delivery: {
      title: "BETALING & LEVERING",
      howToPay: "Hoe te betalen.",
      delivery: "Levering.",
      dispatch: "Verzending.",
    },
    notes: {
      howToPayCard: "Online met kaart via de knop hierboven, of met een SWIFT-overschrijving naar de vermelde rekening.",
      howToPaySwift: "Met een SWIFT-overschrijving naar de vermelde rekening.",
      dispatchWithLead: "De goederen worden binnen {days} dagen na ontvangst van de betaling verzonden.",
      dispatchNoLead: "De goederen worden verzonden zodra de betaling is ontvangen.",
      policyLine: "Door te bestellen bij {brand} aanvaardt u de voorwaarden van ons leveringsbeleid op {url}.",
      leadTime: "{days} dagen na betaling",
      dueOnReceipt: "Betaalbaar bij ontvangst",
      netDays: "Netto {days} dagen",
    },
    signature: { authorised: "BEVOEGDE HANDTEKENING" },
    page: { invoice: "FACTUUR", pageOf: "PAGINA {page} VAN {pages}" },
    incoterms: {
      EXW: {
        label: "EXW — af fabriek",
        delivery:
          "Afhaling in onze vestiging in Foshan. Uitvoerformaliteiten, vracht, invoerrechten en levering worden door de koper geregeld en betaald.",
      },
      FOB: {
        label: "FOB — vrij aan boord",
        delivery:
          "Levering aan boord in de overeengekomen haven van verscheping. Zeevracht, verzekering, invoerrechten en binnenlands transport zijn voor rekening van de koper.",
      },
      CIF: {
        label: "CIF — kosten, verzekering en vracht",
        delivery:
          "Zeevracht en verzekering tot de overeengekomen haven van bestemming zijn inbegrepen. Invoerrechten, douaneafhandeling en verdere levering betaalt de koper.",
      },
      DAP: {
        label: "DAP — geleverd op de plaats van bestemming",
        delivery:
          "Levering op het vermelde adres. Invoerrechten en douaneafhandeling zijn bij aankomst voor rekening van de koper.",
      },
      DDP: {
        label: "DDP — geleverd, rechten betaald",
        delivery:
          "Levering van deur tot deur onder DDP-voorwaarden. Invoerrechten, douaneafhandeling en leveringskosten zijn in de prijs inbegrepen.",
      },
    },
  },

  pt: {
    documentType: "Fatura comercial",
    status: {
      draft: "RASCUNHO",
      awaiting: "AGUARDA PAGAMENTO",
      part_paid: "PARCIALMENTE PAGA",
      paid: "PAGA",
      voided: "ANULADA",
    },
    watermark: { draft: "RASCUNHO", voided: "ANULADA" },
    header: { invoiceNo: "FATURA N.º" },
    meta: { issued: "DATA DE EMISSÃO", due: "VENCIMENTO", currency: "MOEDA" },
    parties: {
      seller: "VENDEDOR",
      billTo: "FATURAR A",
      attn: "Ao cuidado de {name}",
      regNo: "N.º de registo {no}",
    },
    terms: {
      incoterms: "INCOTERMS",
      destination: "DESTINO",
      leadTime: "PRAZO DE ENTREGA",
      paymentTerms: "CONDIÇÕES DE PAGAMENTO",
    },
    goods: {
      title: "Mercadorias",
      titleContinued: "Mercadorias (continuação)",
      product: "PRODUTO",
      spec: "MODELO E ESPECIFICAÇÕES",
      qty: "QTD.",
      unitPrice: "PREÇO UNITÁRIO",
      amount: "MONTANTE",
      sku: "REF.",
      noImage: "SEM IMAGEM",
      saveEach: "POUPE {amount} POR UNIDADE",
    },
    pay: {
      title: "Pagar online",
      blurbCard: "Os pagamentos com cartão são processados de forma segura através do nosso checkout HubSpot.",
      blurbOnline: "Pague online em segurança através do nosso checkout HubSpot.",
      partialNote: " São aceites pagamentos parciais nesta fatura.",
      payNow: "Pagar {amount}",
      payRemaining: "Pagar o saldo {amount}",
      transferNote: "Ou efetue uma transferência para a conta bancária indicada abaixo, mencionando a fatura {number}",
      paidMark: "PAGA",
      paidBlurb: "Obrigado. Esta fatura está integralmente liquidada; não há qualquer pagamento em falta.",
    },
    totals: {
      gross: "Valor bruto",
      discount: "Desconto comercial",
      discountPct: "Desconto comercial ({pct} %)",
      subtotal: "Subtotal",
      fees: "Transporte, direitos e manuseamento",
      tax: "Impostos",
      paidToDate: "Pago até à data",
      balanceDue: "Saldo em dívida",
      total: "TOTAL A PAGAR",
      saved: "POUPOU",
      savedPct: "{pct} % sobre o preço de tabela",
    },
    bank: {
      title: "TRANSFERÊNCIA BANCÁRIA",
      accountName: "Titular da conta",
      accountNumber: "Número de conta",
      bank: "Banco",
      address: "Morada",
      swift: "SWIFT / BIC",
      routing: "Código de encaminhamento",
      currencies: "Moedas",
    },
    delivery: {
      title: "PAGAMENTO E ENTREGA",
      howToPay: "Como pagar.",
      delivery: "Entrega.",
      dispatch: "Expedição.",
    },
    notes: {
      howToPayCard: "Com cartão online através do botão acima, ou por transferência SWIFT para a conta indicada.",
      howToPaySwift: "Por transferência SWIFT para a conta indicada.",
      dispatchWithLead: "As mercadorias são expedidas no prazo de {days} dias após a boa cobrança do pagamento.",
      dispatchNoLead: "As mercadorias são expedidas após a boa cobrança do pagamento.",
      policyLine: "Ao encomendar à {brand}, aceita os termos da nossa política de entrega disponível em {url}.",
      leadTime: "{days} dias após pagamento",
      dueOnReceipt: "Pagamento na receção",
      netDays: "Pagamento a {days} dias",
    },
    signature: { authorised: "ASSINATURA AUTORIZADA" },
    page: { invoice: "FATURA", pageOf: "PÁGINA {page} DE {pages}" },
    incoterms: {
      EXW: {
        label: "EXW — à saída da fábrica",
        delivery:
          "Levantamento nas nossas instalações em Foshan. O desalfandegamento de exportação, o frete, os direitos de importação e a entrega são organizados e pagos pelo comprador.",
      },
      FOB: {
        label: "FOB — franco a bordo",
        delivery:
          "Entrega a bordo no porto de embarque designado. O frete marítimo, o seguro, os direitos de importação e o transporte interno são da responsabilidade do comprador.",
      },
      CIF: {
        label: "CIF — custo, seguro e frete",
        delivery:
          "O frete marítimo e o seguro até ao porto de destino designado estão incluídos. Os direitos de importação, o desalfandegamento e a entrega subsequente são pagos pelo comprador.",
      },
      DAP: {
        label: "DAP — entregue no local",
        delivery:
          "Entrega na morada indicada. Os direitos de importação e o desalfandegamento são da responsabilidade do comprador à chegada.",
      },
      DDP: {
        label: "DDP — entregue com direitos pagos",
        delivery:
          "Entrega porta a porta em condições DDP. Os direitos de importação, o desalfandegamento e os encargos de entrega estão incluídos no preço.",
      },
    },
  },
};

const SUPPORTED_LANGUAGES = Object.keys(DICTIONARIES);

/* ------------------------------------------------------------------ helpers */

/**
 * "{days} days from payment" + { days: 12 } → "12 days from payment".
 * A placeholder with no value is left in place rather than blanked, so a typo
 * shows up in review instead of silently eating the sentence.
 */
function fmt(template, vars = {}) {
  return String(template ?? "").replace(/\{(\w+)\}/g, (match, key) =>
    vars[key] === undefined || vars[key] === null ? match : String(vars[key]));
}

/**
 * Spec p.10 prints the signature date as "4 SEP 2026", but en-GB/en-IE
 * abbreviate September as "Sept". Only English is corrected — every other
 * language keeps the abbreviation its own readers expect ("sept." in French,
 * "set" in Italian), and pt-PT resolves a short month to "4/09/2026", which is
 * the normal Portuguese form for that pattern.
 */
function signatureDate(shortLabel, lang) {
  if (!shortLabel) return null;
  return (lang === "en" ? shortLabel.replace(/\bSept\b/, "Sep") : shortLabel).toUpperCase();
}

// "pt-BR" / "fr_FR" / "EN" → "pt" / "fr" / "en".
function baseLanguage(value) {
  if (!value) return null;
  return String(value).trim().toLowerCase().replace(/_/g, "-").split("-")[0] || null;
}

function canonicalLocale(value) {
  if (!value) return null;
  try {
    return Intl.getCanonicalLocales(String(value).trim().replace(/_/g, "-"))[0] || null;
  } catch {
    return null; // free-text field in HubSpot; junk must not stop a render
  }
}

/**
 * Which language to print in, and which locales to format with.
 * `fallback` is true when the invoice named a language we have no dictionary
 * for — the caller logs it so the gap is visible rather than silent.
 */
function resolve(hsLanguage, hsLocale) {
  const requested = baseLanguage(hsLanguage) || baseLanguage(hsLocale);
  const lang = SUPPORTED_LANGUAGES.includes(requested) ? requested : DEFAULT_LANGUAGE;
  // hs_language is usually bare ("pt"), but HubSpot also writes "pt-br" there;
  // take the region from whichever field carries one. A value with no region
  // tells us nothing, so it leaves the language's default locale in place.
  const withRegion = (v) => {
    const c = canonicalLocale(v);
    return c && c.includes("-") ? c : null;
  };
  const canonical = withRegion(hsLocale) || withRegion(hsLanguage);

  return {
    lang,
    requested,
    fallback: Boolean(requested) && requested !== lang,
    // A region only carries over when it belongs to the language being printed.
    locale: canonical && baseLanguage(canonical) === lang ? canonical : DEFAULT_LOCALES[lang],
    dateLocale: DEFAULT_LOCALES[lang],
  };
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function deepMerge(base, override) {
  const out = { ...base };
  for (const [key, value] of Object.entries(override || {})) {
    out[key] = isObject(value) && isObject(base[key]) ? deepMerge(base[key], value) : value;
  }
  return out;
}

// English underneath every language, so a key added to `en` but not yet
// translated prints in English instead of disappearing.
function dictionary(lang) {
  const chosen = DICTIONARIES[lang];
  return chosen && lang !== DEFAULT_LANGUAGE
    ? deepMerge(DICTIONARIES[DEFAULT_LANGUAGE], chosen)
    : { ...DICTIONARIES[DEFAULT_LANGUAGE] };
}

module.exports = {
  DEFAULT_LANGUAGE,
  DEFAULT_LOCALES,
  SUPPORTED_LANGUAGES,
  dictionary,
  fmt,
  resolve,
  signatureDate,
};
