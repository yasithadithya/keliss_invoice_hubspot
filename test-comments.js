// Fixtures for the comment → bank box parser. Every case is a real comment
// from the live portal, or a shape reps are known to type.
//
//   node test-comments.js
//
// Failures print the field, what was expected and what came out; exit code 1.

const { htmlToText, parseBankFromComments } = require("./comments.js");

const DBS_ONE_FIELD_PER_LINE =
  '<div><p>Lead Time : 15 -35 business days from receiving payment（The customer shall pay a ' +
  '<strong>50% deposit($6667.5)</strong> upon order confirmation.）</p><br>' +
  "<p>Account Number: 79829000464</p><p>Account Holder Name: Foshan CaptaiNext Technology Co., Ltd</p>" +
  "<p>Supported Currencies: EUR GBP USD JPY CAD AUD CNH HKD SGD SEK CHF DKK NOK NZD</p>" +
  "<p>Bank Name: DBS BANK (HONG KONG) LIMITED</p><p>Country/Region: HONG KONG, CHINA</p>" +
  "<p>Bank Address: 11th Floor, The Center, 99 Queen's Road Central, Central, Hong Kong</p>" +
  "<p>Account Type: Current</p><p>Swift Code/BIC: DHBKHKHH (DHBKHKHHXXXIf 11 characters are required)</p>" +
  '<p><a href="https://www.keliss.com/privacy-policy/">Privacy Policy</a></p></div>';

// The same account, but with two labels run into one paragraph.
const DBS_LABELS_SHARING_A_LINE =
  "<div><p><strong>Lead Time:</strong> 15 business days from receiving payment</p>" +
  "<p>Account Number: 79829000464 </p><p>Account Holder Name: Foshan CaptaiNext Technology Co., Ltd </p>" +
  "<p>Supported Currencies: EUR GBP USD JPY CAD AUD CNH HKD SGD SEK CHF DKK NOK NZD </p>" +
  "<p>Bank Name: DBS BANK (HONG KONG) LIMITED Country/Region: HONGKONG,CHINA</p>" +
  "<p> Bank Address: 11th Floor, The Center, 99 Queen's Road Central, Central, Hong Kong Account Type: Current </p>" +
  "<p>Swift Code/BIC: DHBKHKHH (DHBKHKHHXXXIf 11 characters are required)</p></div>";

const WITH_BANK_AND_BRANCH_CODE =
  "<div><p>Account Number: 79829000464</p><p>Account Name: Foshan CaptaiNext Technology Co., Ltd</p>" +
  "<p>Bank Name: DBS BANK (HONG KONG) LIMITED</p><p>Bank Code: 016</p><p>Branch Code: 478</p>" +
  "<p>Swift Code/BIC: DHBKHKHH</p></div>";

const NO_BANK_AT_ALL =
  "<div><p>Lead time 20 days. Please quote the invoice number on the transfer.</p></div>";

// An account number alone is not enough to pay into — leave it in the comment.
const TOO_LITTLE = "<div><p>Account Number: 79829000464</p></div>";

const cases = [
  {
    name: "one field per line",
    html: DBS_ONE_FIELD_PER_LINE,
    bank: {
      accountNumber: "79829000464",
      accountName: "Foshan CaptaiNext Technology Co., Ltd",
      bank: "DBS BANK (HONG KONG) LIMITED",
      address: "11th Floor, The Center, 99 Queen's Road Central, Central, Hong Kong",
      accountType: "Current",
      swift: "DHBKHKHH (DHBKHKHHXXXIf 11 characters are required)",
      currencies: "EUR · GBP · USD · JPY · CAD · AUD · CNH · HKD · SGD · SEK · CHF · DKK · NOK · NZD",
      routing: null,
    },
    commentsInclude: ["Lead Time", "Privacy Policy"],
    commentsExclude: ["79829000464", "DBS BANK", "Swift", "Account Type"],
  },
  {
    name: "two labels in one paragraph",
    html: DBS_LABELS_SHARING_A_LINE,
    bank: {
      accountNumber: "79829000464",
      bank: "DBS BANK (HONG KONG) LIMITED",          // must stop before Country/Region
      address: "11th Floor, The Center, 99 Queen's Road Central, Central, Hong Kong",
      accountType: "Current",                         // trailing label on the address line
    },
    commentsInclude: ["Lead Time"],
    commentsExclude: ["HONGKONG", "DBS BANK", "79829000464"],
  },
  {
    name: "bank + branch code become the routing line",
    html: WITH_BANK_AND_BRANCH_CODE,
    bank: { routing: "Bank 016 · Branch 478", accountName: "Foshan CaptaiNext Technology Co., Ltd" },
  },
  { name: "no bank block", html: NO_BANK_AT_ALL, bank: null, commentsInclude: ["Lead time 20 days"] },
  { name: "account number only", html: TOO_LITTLE, bank: null, commentsInclude: ["79829000464"] },
];

let failed = 0;
const fail = (name, msg) => { failed++; console.log(`  FAIL  ${name}: ${msg}`); };

for (const c of cases) {
  const text = htmlToText(c.html);
  const got = parseBankFromComments(text);

  if (c.bank === null) {
    if (got.bank) fail(c.name, `expected no bank block, got ${JSON.stringify(got.bank)}`);
  } else if (!got.bank) {
    fail(c.name, "expected a bank block, got none");
  } else {
    for (const [k, want] of Object.entries(c.bank)) {
      if (got.bank[k] !== want) fail(c.name, `bank.${k}\n     want: ${want}\n     got:  ${got.bank[k]}`);
    }
  }

  const comments = got.comments || "";
  for (const s of c.commentsInclude || []) {
    if (!comments.includes(s)) fail(c.name, `comment should still contain "${s}"\n     got: ${comments}`);
  }
  for (const s of c.commentsExclude || []) {
    if (comments.includes(s)) fail(c.name, `comment should not contain "${s}"\n     got: ${comments}`);
  }
  if (!failed) console.log(`  ok    ${c.name}`);
}

console.log(failed ? `\n${failed} failure(s)` : `\nall ${cases.length} cases pass`);
process.exit(failed ? 1 : 0);
