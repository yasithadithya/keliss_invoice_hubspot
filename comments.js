/**
 * Invoice comments: turning HubSpot rich text into the bank box.
 *
 * Reps paste the account they want paid into the invoice comments. Everything
 * that parses as a bank field is lifted into the bank box; the rest of the
 * comment prints as written. Lives outside worker.js so it can be tested on
 * its own — see test-comments.js.
 */

/**
 * hs_comments is rich text. Keep the line structure, because the bank block
 * below is written one field per paragraph.
 */
function htmlToText(html) {
  return String(html || "")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*(p|div|li|tr|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#3[49];/g, "'")
    .replace(/[ \t]+/g, " ")
    .split("\n").map((l) => l.trim()).join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Reps paste the account they want paid into the invoice comments, one
 * "Label: value" per line. Anything recognised here is lifted into the bank
 * box and removed from the comment; the rest of the comment prints as written.
 *
 * Labels are matched anywhere, not just at the start of a line: reps often run
 * two of them into one paragraph ("Bank Name: DBS … Country/Region: HONG KONG").
 * A value therefore ends at the next label or the end of its line.
 */
const BANK_LABELS = [
  ["accountName", ["account holder name", "account holder", "account name", "beneficiary name", "beneficiary"]],
  ["accountNumber", ["account number", "account no", "iban"]],
  // "bank" and "address" on their own come last in the alternation, so
  // "bank code" and "bank address" still win where both could match.
  ["bank", ["bank name", "bank"]],
  ["address", ["bank address", "address"]],
  ["country", ["country/region", "country / region", "country"]],
  ["swift", ["swift code/bic", "swift code / bic", "swift / bic code", "swift/bic code",
             "swift code", "swift/bic", "bic code", "swift", "bic"]],
  ["accountType", ["account type"]],
  ["currencies", ["supported currencies", "accepted currencies", "currencies"]],
  ["bankCode", ["bank code"]],
  ["branchCode", ["branch code"]],
  ["routing", ["routing number", "routing", "sort code"]],
];

const KEY_BY_ALIAS = new Map();
for (const [key, aliases] of BANK_LABELS) for (const a of aliases) KEY_BY_ALIAS.set(a, key);
// Longest first, so "account holder name" wins over "account holder".
const LABEL_RE = new RegExp(
  `(${[...KEY_BY_ALIAS.keys()]
    .sort((a, b) => b.length - a.length)
    .map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s*"))
    .join("|")})\\s*[:：]\\s*`,
  "gi");

const squash = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");

function parseBankFromComments(text) {
  if (!text) return { bank: null, comments: null };

  const matches = [...text.matchAll(LABEL_RE)];
  const found = {};
  const spans = [];

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const key = KEY_BY_ALIAS.get(m[1].toLowerCase().replace(/\s+/g, " "));
    const start = m.index + m[0].length;
    const newline = text.indexOf("\n", start);
    const nextLabel = matches[i + 1] ? matches[i + 1].index : text.length;
    const end = Math.min(nextLabel, newline === -1 ? text.length : newline);
    const value = text.slice(start, end).trim().replace(/[;,]$/, "");
    if (!value) continue;
    if (!found[key]) found[key] = value;
    spans.push([m.index, end]);
  }

  // Not a bank block unless it can actually be paid into.
  if (!found.accountNumber || !(found.bank || found.swift)) {
    return { bank: null, comments: text || null };
  }

  // The country is usually already spelled out in the address.
  const inAddress = found.country && found.address &&
    found.country.split(/[^A-Za-z]+/).filter((w) => w.length > 3)
      .some((w) => squash(found.address).includes(squash(w)));
  const address = [found.address, inAddress ? null : found.country].filter(Boolean).join(", ") || null;

  const routing = found.routing ||
    [found.bankCode && `Bank ${found.bankCode}`, found.branchCode && `Branch ${found.branchCode}`]
      .filter(Boolean).join(" · ") || null;

  const bank = {
    accountName: found.accountName || null,
    accountNumber: found.accountNumber,
    accountType: found.accountType || null,
    bank: found.bank || null,
    address,
    swift: found.swift || null,
    routing,
    // "EUR GBP USD" and "EUR €, USD $" both reduce to the codes.
    currencies: found.currencies
      ? (found.currencies.match(/\b[A-Z]{3}\b/g) || [found.currencies]).join(" · ")
      : null,
  };

  // Drop the block from the comment, back to front so the offsets stay valid.
  let rest = text;
  for (const [from, to] of spans.reverse()) rest = rest.slice(0, from) + rest.slice(to);
  rest = rest
    .split("\n")
    .map((l) => l.trim())
    // A heading such as "Payment Information:" is left dangling once the
    // fields under it have been lifted out.
    .filter((l) => !/^[^:]{1,40}:$/.test(l))
    .filter((l, i, a) => l || (i && a[i - 1]))
    .join("\n").replace(/\n{3,}/g, "\n\n").trim();

  return { bank, comments: rest || null };
}

module.exports = { htmlToText, parseBankFromComments };
