// Canonical UAE legal-form catalogue.
//
// Why this exists: the tracker used to offer four entity types (FZCO, FZE,
// FZ-LLC, Mainland LLC). That is not enough to tell a DIFC company from an
// offshore holding company from a representative office — and the difference
// decides whether a client can claim the free-zone 0% corporate-tax rate,
// whether it has to register for CT at all, and whether it can invoice inside
// the UAE. So the full set of forms is listed here with one line of plain
// guidance each, and the team picks from that instead of guessing.
//
// IMPORTANT: app.html carries the same catalogue for the browser (it is served
// as a static file and cannot require this module). scripts/check-entity-types.js
// asserts the two stay identical — run it before shipping a change here.

// group = the heading it sits under in the dropdown
// hint  = when to choose this one, in the words an accountant would use
var ENTITY_TYPE_CATALOGUE = [
  // ---- Mainland: licensed by an Economic Department, trades anywhere in the UAE
  { value: 'Mainland — LLC',                     group: 'Mainland (Economic Department licence)', hint: 'The usual onshore company with two or more owners. Trades anywhere in the UAE. Corporate tax at 9% above AED 375,000 — no free-zone 0% relief.' },
  { value: 'Mainland — One Person LLC',          group: 'Mainland (Economic Department licence)', hint: 'An LLC with a single owner. Same tax and audit position as a normal LLC — pick this only when the licence itself says "One Person".' },
  { value: 'Mainland — Sole Establishment',      group: 'Mainland (Economic Department licence)', hint: 'One individual trading in their own name, usually on a professional licence. The owner is personally liable for everything.' },
  { value: 'Mainland — Civil Company',           group: 'Mainland (Economic Department licence)', hint: 'A partnership of professionals — doctors, engineers, consultants, accountants. Partners are personally liable.' },
  { value: 'Mainland — Private Joint Stock',     group: 'Mainland (Economic Department licence)', hint: 'Shares held privately among founders, not offered to the public. Rare for SMEs — the licence will say PrJSC.' },
  { value: 'Mainland — Public Joint Stock',      group: 'Mainland (Economic Department licence)', hint: 'Listed, or able to offer shares publicly. Audited financial statements are compulsory every year.' },
  { value: 'Mainland — Branch of a Foreign Company', group: 'Mainland (Economic Department licence)', hint: 'An arm of an overseas parent, with no share capital of its own. It still files its own UAE corporate tax return.' },
  { value: 'Mainland — Branch of a UAE Company', group: 'Mainland (Economic Department licence)', hint: "An arm of another UAE company. It is the same legal person as the parent, so corporate tax normally goes in the parent's return." },
  { value: 'Mainland — Representative Office',   group: 'Mainland (Economic Department licence)', hint: 'Marketing and liaison only. It cannot trade or raise invoices, so there is no revenue to account for.' },

  // ---- Free zone: licensed by a zone authority; may qualify for 0% CT on qualifying income
  { value: 'Free Zone — FZE (single shareholder)',        group: 'Free Zone', hint: 'Free Zone Establishment: exactly one shareholder. Can claim the 0% rate on qualifying income if it meets the free-zone conditions.' },
  { value: 'Free Zone — FZCO / FZC (two or more shareholders)', group: 'Free Zone', hint: 'Free Zone Company: two or more shareholders. Same 0% possibility on qualifying income as an FZE.' },
  { value: 'Free Zone — FZ-LLC',                          group: 'Free Zone', hint: 'The same thing as an FZCO — it is just the label DMCC, Dubai South and a few other zones print on the licence. Go by the licence wording.' },
  { value: 'Free Zone — Branch',                          group: 'Free Zone', hint: 'A branch of a mainland or foreign company registered inside a free zone. Being in a zone does not by itself give it the 0% rate.' },
  { value: 'Free Zone — Freelance Permit',                group: 'Free Zone', hint: 'An individual permit, not a company. Corporate tax only bites once business turnover passes AED 1 million in a calendar year.' },

  // ---- Financial free zones: their own registrar, courts and accounting rules
  { value: 'DIFC — Company',  group: 'Financial free zone (own registrar and courts)', hint: 'Dubai International Financial Centre company. Its own companies law and filing calendar — do not treat it like a Dubai mainland LLC.' },
  { value: 'DIFC — Branch',   group: 'Financial free zone (own registrar and courts)', hint: 'A branch registered with the DIFC registrar rather than an Economic Department.' },
  { value: 'ADGM — Company',  group: 'Financial free zone (own registrar and courts)', hint: 'Abu Dhabi Global Market company. Common-law rules and its own registrar, separate from Abu Dhabi mainland.' },
  { value: 'ADGM — Branch',   group: 'Financial free zone (own registrar and courts)', hint: 'A branch registered with the ADGM registrar.' },

  // ---- Offshore: holding vehicles that cannot trade inside the UAE
  { value: 'Offshore — JAFZA Offshore', group: 'Offshore (cannot trade inside the UAE)', hint: 'A Jebel Ali offshore holding company. No UAE trading, no office, no visas — usually just holds shares or property.' },
  { value: 'Offshore — RAK ICC',        group: 'Offshore (cannot trade inside the UAE)', hint: 'A Ras Al Khaimah International Corporate Centre company. Holding and asset ownership only.' },
  { value: 'Offshore — Ajman Offshore',  group: 'Offshore (cannot trade inside the UAE)', hint: 'An Ajman offshore holding company. Same restriction — it cannot trade or invoice within the UAE.' },

  // ---- Everything else
  { value: 'Foundation',                 group: 'Other structures', hint: 'A DIFC, ADGM or RAK ICC foundation. It has no shareholders — it is used to hold assets and plan succession.' },
  { value: 'Trust',                      group: 'Other structures', hint: 'A trust arrangement rather than a company. Choose this only when the instrument is actually a trust deed.' },
  { value: 'Partnership (General or Limited)', group: 'Other structures', hint: 'A partnership registered as such. General partners carry unlimited liability; limited partners do not.' },
  { value: 'Non-profit / Association',   group: 'Other structures', hint: 'An association, society or non-profit body. Corporate tax may be exempt, but only once the exemption is actually granted.' },
  { value: 'Natural Person (individual licence)', group: 'Other structures', hint: 'An individual doing business in their own name. They register for corporate tax only if business turnover crosses AED 1 million in a calendar year.' },
  { value: 'Not Recorded',               group: 'Other structures', hint: 'Use only as a placeholder when the trade licence has not been seen yet. Anything sitting here should be fixed before the first filing.' }
];

var ENTITY_TYPES = ENTITY_TYPE_CATALOGUE.map(function(e) { return e.value; });

// The four labels the tracker used before this catalogue existed, plus the
// spellings that turn up in the Excel imports. Kept so old rows and old
// templates still load instead of failing validation.
var LEGACY_ENTITY_ALIASES = {
  'mainland llc': 'Mainland — LLC',
  'llc': 'Mainland — LLC',
  'mainland': 'Mainland — LLC',
  'fzco (free zone)': 'Free Zone — FZCO / FZC (two or more shareholders)',
  'fzco': 'Free Zone — FZCO / FZC (two or more shareholders)',
  'fzc': 'Free Zone — FZCO / FZC (two or more shareholders)',
  'fze (free zone)': 'Free Zone — FZE (single shareholder)',
  'fze': 'Free Zone — FZE (single shareholder)',
  'fz-llc (free zone)': 'Free Zone — FZ-LLC',
  'fz-llc': 'Free Zone — FZ-LLC',
  'fz llc': 'Free Zone — FZ-LLC',
  'free zone': 'Free Zone — FZCO / FZC (two or more shareholders)',
  'difc': 'DIFC — Company',
  'adgm': 'ADGM — Company',
  'offshore': 'Offshore — RAK ICC',
  'branch': 'Mainland — Branch of a Foreign Company',
  'sole establishment': 'Mainland — Sole Establishment',
  'sole proprietorship': 'Mainland — Sole Establishment',
  'civil company': 'Mainland — Civil Company',
  'pjsc': 'Mainland — Public Joint Stock',
  'prjsc': 'Mainland — Private Joint Stock'
};

// Accept a label from an import or an older record and return a catalogue
// value. Returns '' when it is not recognisable, so the caller can decide
// whether to reject the row or park it at 'Not Recorded'.
function normalizeEntityType(raw) {
  var s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  var exact = ENTITY_TYPES.find(function(v) { return v.toLowerCase() === s.toLowerCase(); });
  if (exact) return exact;
  // Both em dash and hyphen turn up depending on who typed it.
  var loose = s.toLowerCase().replace(/—/g, '-').replace(/\s+/g, ' ');
  var byDash = ENTITY_TYPES.find(function(v) {
    return v.toLowerCase().replace(/—/g, '-').replace(/\s+/g, ' ') === loose;
  });
  if (byDash) return byDash;
  return LEGACY_ENTITY_ALIASES[s.toLowerCase()] || '';
}

// Best guess at the legal form from the company name, used only to pre-fill
// the field when clients are pulled in bulk from the Ops-Mkt tracker (which
// does not record entity type at all).
//
// This is a suggestion, never a decision: every guessed row is flagged
// entityTypeGuessed so the UI can ask someone to confirm it against the
// trade licence. A name is not proof of anything — "Al Noor Trading LLC" in a
// free zone is still a free-zone company.
function guessEntityTypeFromName(name) {
  var s = ' ' + String(name == null ? '' : name).toLowerCase().replace(/[.,()'"`]/g, ' ').replace(/\s+/g, ' ') + ' ';
  // Order matters — the more specific label has to win. "FZ-LLC" must not be
  // read as a plain "LLC", and "DMCC" must not fall through to mainland.
  var rules = [
    [/\bdifc\b/,                               'DIFC — Company'],
    [/\badgm\b/,                               'ADGM — Company'],
    [/\brak\s*icc\b|\bictc\b/,                 'Offshore — RAK ICC'],
    [/\boffshore\b/,                           'Offshore — RAK ICC'],
    [/\bfoundation\b/,                         'Foundation'],
    [/\bfz\s*-?\s*llc\b/,                      'Free Zone — FZ-LLC'],
    [/\bfzco\b|\bfzc\b/,                       'Free Zone — FZCO / FZC (two or more shareholders)'],
    [/\bfze\b/,                                'Free Zone — FZE (single shareholder)'],
    // Zone-name suffixes that mean free zone without spelling out the form.
    [/\bdmcc\b|\bjlt\b|\bdwc\b|\bdafza\b|\bsaif\b|\bifza\b|\bshams\b|\brakez\b|\bmeydan\b|\bdso\b|\bdubai\s+south\b/, 'Free Zone — FZCO / FZC (two or more shareholders)'],
    [/\bfree\s*zone\b|\bfz\b/,                 'Free Zone — FZCO / FZC (two or more shareholders)'],
    [/\bbranch\b/,                             'Mainland — Branch of a Foreign Company'],
    [/\bpjsc\b|\bp\s*j\s*s\s*c\b/,             'Mainland — Public Joint Stock'],
    [/\bprjsc\b/,                              'Mainland — Private Joint Stock'],
    [/\bl\s*l\s*c\b|\bllc\b/,                  'Mainland — LLC'],
    [/\bestablishment\b|\best\b/,               'Mainland — Sole Establishment'],
    [/\bcivil\b/,                              'Mainland — Civil Company']
  ];
  for (var i = 0; i < rules.length; i++) {
    if (rules[i][0].test(s)) return rules[i][1];
  }
  return '';
}

// ---- Business nature: trading vs service.
// Kept deliberately short. It drives what the team expects to see in the
// books (stock and cost of goods for a trader, none for a service firm), so a
// long taxonomy would only invite inconsistent answers.
var BUSINESS_NATURES = ['Trading', 'Service', 'Trading & Service', 'Other', 'Not Recorded'];

// Ops-Mkt records a freeform "nature of business" on some clients. Fold its
// values into ours where the meaning is clear, and leave the rest for the team.
function normalizeBusinessNature(raw) {
  var s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!s) return 'Not Recorded';
  if (/^trading|retail|e-?commerce|import|export|distribut/.test(s)) return 'Trading';
  if (/^services?$|consult|professional|technology|\bit\b|software|marketing|advisor/.test(s)) return 'Service';
  if (/both|trading\s*&|trading\s*and/.test(s)) return 'Trading & Service';
  var exact = BUSINESS_NATURES.find(function(v) { return v.toLowerCase() === s; });
  return exact || 'Other';
}

module.exports = {
  ENTITY_TYPE_CATALOGUE: ENTITY_TYPE_CATALOGUE,
  ENTITY_TYPES: ENTITY_TYPES,
  LEGACY_ENTITY_ALIASES: LEGACY_ENTITY_ALIASES,
  normalizeEntityType: normalizeEntityType,
  guessEntityTypeFromName: guessEntityTypeFromName,
  BUSINESS_NATURES: BUSINESS_NATURES,
  normalizeBusinessNature: normalizeBusinessNature
};
