#!/usr/bin/env node
// Parse the master CV (QadirCV.tex) into data/cv_entries.json.
//
// The CV is the source of truth: the archive trails the CV, never leads it.
// Usage:  node tools/parse_cv.mjs /path/to/QadirCV.tex
//
// Handles the `cvenum{J|C|BC|MI|I}` numbered lists in the Publications section.
// The CV prints each list newest-first with numbers counting DOWN, so the oldest
// entry is always [1]; numbers of existing entries stay stable when new papers are
// added at the top.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cvPath = process.argv[2] || process.env.CV_TEX;
if (!cvPath) {
  console.error("usage: node tools/parse_cv.mjs /path/to/QadirCV.tex");
  process.exit(1);
}

const SECTIONS = { J: "journal", C: "conference", BC: "book-chapter", MI: "misc", I: "informal" };
const MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December";

const ACCENTS = {
  "\\'a": "á", "\\'e": "é", "\\'i": "í", "\\'o": "ó", "\\'u": "ú",
  "\\`a": "à", '\\"a': "ä", '\\"o': "ö", '\\"u': "ü", "\\c{c}": "ç", "\\c c": "ç",
  "\\'{a}": "á", "\\'{e}": "é", "\\'{i}": "í", "\\'{o}": "ó", "\\'{u}": "ú",
  "\\^o": "ô", "\\~n": "ñ", "\\v{s}": "š", "\\v{c}": "č",
};

function unwrap(s) {
  // Resolve \cmd{...} wrappers (innermost first) until stable.
  let prev;
  do {
    prev = s;
    s = s.replace(/\\(?:textbf|textit|emph|textsc|textsuperscript|underline|mbox)\{([^{}]*)\}/g, "$1");
  } while (s !== prev);
  return s;
}

function clean(s) {
  for (const [k, v] of Object.entries(ACCENTS)) s = s.split(k).join(v);
  s = s.replace(/\\href\{[^{}]*\}\{([^{}]*)\}/g, "$1").replace(/\\url\{[^{}]*\}/g, "");
  s = unwrap(s);
  return s
    .replace(/\\&/g, "&").replace(/\\%/g, "%").replace(/\\_/g, "_").replace(/\\\$/g, "$")
    .replace(/\\newline|\\\\/g, " ").replace(/~/g, " ")
    .replace(/---/g, "—").replace(/--/g, "–")
    .replace(/``/g, "“").replace(/''/g, "”")
    .replace(/\\[a-zA-Z]+\*?/g, "") // any leftover macro names
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normTitle(t) {
  return (t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// ---- locate the Publications region (ignoring commented-out lines) ----
const lines = readFileSync(cvPath, "utf8")
  .split("\n")
  .filter((l) => !/^\s*%/.test(l));
const body = lines.join("\n");
const start = body.indexOf("\\parag{Publications}");
const end = body.indexOf("\\parag{Courses Taught}");
if (start < 0 || end < 0) throw new Error("Could not find the Publications region in the CV");
const pubs = body.slice(start, end);

const envRe = /\\begin\{cvenum\}\{(\w+)\}([\s\S]*?)\\end\{cvenum\}/g;
const entries = [];
let m;
while ((m = envRe.exec(pubs))) {
  const [, code, block] = m;
  const section = SECTIONS[code];
  if (!section) continue;
  const items = block.split(/\n\s*\\item\s+/).slice(1).map((s) => s.trim()).filter(Boolean);
  items.forEach((raw, i) => {
    entries.push(parseEntry(raw, code, section, items.length - i));
  });
}

function parseEntry(raw, code, section, number) {
  // URLs first (from raw LaTeX, before cleaning drops them)
  const urls = [...raw.matchAll(/\\url\{([^{}]+)\}/g)].map((x) => x[1]);
  const hrefs = [...raw.matchAll(/\\href\{([^{}]+)\}\{/g)].map((x) => x[1]);
  const allUrls = [...new Set([...urls, ...hrefs])];
  const doiUrl = allUrls.find((u) => /doi\.org\/10\./i.test(u));
  let doi = doiUrl ? doiUrl.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "") : null;
  if (!doi) {
    const bare = raw.match(/\bdoi:\s*(10\.\d{4,9}\/[^\s,;]+)/i);
    if (bare) doi = bare[1].replace(/[.,]$/, "");
  }
  const arxiv = (raw.match(/arXiv:\s*(\d{4}\.\d{4,5})/i) || [])[1] || null;
  const otherLinks = allUrls.filter((u) => !/doi\.org\/10\./i.test(u) || u !== doiUrl);

  const plain = clean(raw);
  const tm = plain.match(/“([^”]+)”/);
  let title = tm ? tm[1].replace(/[,.\s]+$/, "").trim() : null;

  // split into before/after the quoted title
  let before = "", after = plain;
  if (tm) {
    const idx = plain.indexOf(tm[0]);
    before = plain.slice(0, idx).replace(/[,\s]+$/, "");
    after = plain.slice(idx + tm[0].length).replace(/^[,\s]+/, "");
  }

  const looksLikeAuthor = (t) =>
    t &&
    t.length < 40 &&
    !/\d/.test(t) &&
    !/\b(IEEE|ACM|Elsevier|Springer|MDPI|Wiley|Nature|Taylor|Francis|Frontiers|Journal|Transactions|Proceedings|Conference|International|Symposium|Workshop|Magazine|Review|Reports|npj|Emerald|IET|JMIR|Society|Access|Systems|Computing|Letters|Science|accepted|published|forthcoming|Volume|Impact)\b/i.test(t) &&
    /^[A-ZÀ-Ý][\p{L}.'’-]*(\s+(?:[A-ZÀ-Ý][\p{L}.'’-]*|[a-z]\.)){0,3}$/u.test(t);

  const splitAuthors = (s) =>
    s.split(/,\s*|\s+and\s+|;\s*/i).map((x) => x.replace(/^(and|by)\s+/i, "").trim()).filter(Boolean);

  let authors = [];
  let rest = after;
  if (before) {
    // authors-first form: everything before the title is the author list
    authors = splitAuthors(before.replace(/^by\s+/i, ""));
  } else {
    // title-first form: walk tokens after the title while they look like names
    const toks = splitAuthors(after);
    let i = 0;
    while (i < toks.length && looksLikeAuthor(toks[i])) authors.push(toks[i++]);
    // rebuild the remainder from the first non-author token on
    const firstNon = toks[i];
    rest = firstNon ? after.slice(after.indexOf(firstNon)) : "";
  }
  authors = [...new Set(authors)];

  // venue: up to the first bibliographic marker
  const markerIdx = rest.search(
    new RegExp(`,\\s*(vol\\.|Vol\\.|Volume|no\\.|Issue|pp\\.|accepted|Accepted|forthcoming|(?:${MONTHS})\\b|(?:19|20)\\d{2}\\b)|\\.\\s+(Impact|Preprint|Available|\\()|\\s+Impact Factor|\\s+\\[`)
  );
  let venue = (markerIdx >= 0 ? rest.slice(0, markerIdx) : rest).trim().replace(/[.,;]+$/, "");
  venue = venue.replace(/^(accepted|published|to appear)( for publication)?( in| at)?\s+/i, "").replace(/^in\s+/i, "");
  // some conference entries carry "pg. 394-399" inside the venue string; pages are parsed separately
  venue = venue.replace(/,?\s*(?:pp?|pg)\.\s*\d+\s*[–-]\s*\d+/g, "").replace(/,\s*,/g, ",").replace(/^,\s*|,\s*$/g, "").trim();
  if (!venue) venue = null;

  const num = (re) => (plain.match(re) || [])[1] || null;
  const volume = num(/\b(?:vol\.|Vol\.|Volume)\s*(\d+)/);
  const issue = num(/\b(?:no\.|Issue)\s*(\d+)/);
  const pm = plain.match(/\b(?:pp?|pg)\.?\s*(\d+)\s*[–-]\s*(\d+)/);
  const pages = pm ? `${pm[1]}–${pm[2]}` : num(/\bpp\.\s*([A-Za-z0-9]+)/);

  // year = last plausible year before an "Impact Factor" note
  const head = plain.split(/Impact [Ff]actor/)[0];
  const years = [...head.matchAll(/\b(19|20)\d{2}\b/g)].map((x) => parseInt(x[0], 10));
  const year = years.length ? years[years.length - 1] : null;

  const status = /\b(forthcoming|to appear)\b/i.test(plain)
    ? "forthcoming"
    : /\baccepted\b/i.test(plain) && !volume
      ? "accepted"
      : "published";

  const awards = [];
  if (/best paper award/i.test(plain)) awards.push("Best Paper Award");
  const prize = plain.match(/\(\s*(Selected to receive[^)]*)\)/i);
  if (prize) awards.push(prize[1].replace(/\.$/, ""));

  return {
    code,
    section,
    number,
    cv_label: `${code}${number}`,
    title,
    authors,
    venue,
    year,
    volume,
    issue,
    pages,
    doi,
    arxiv,
    links: otherLinks,
    status,
    awards,
    plain,
  };
}

// ---- stable, human-readable slugs: year-firstauthor-keywords ----
const STOP = new Set("a an the of for and in on to with from by via toward towards using use based into at as is are its their how what why can do does".split(" "));
const used = new Map();
for (const e of entries) {
  const surname = ((e.authors[0] || "qadir").split(/\s+/).pop() || "qadir").toLowerCase().replace(/[^a-z]/g, "");
  const words = normTitle(e.title || e.plain.slice(0, 60)).split(" ").filter((w) => w && !STOP.has(w)).slice(0, 4);
  let slug = [e.year ?? "nd", surname, ...words].join("-");
  const n = used.get(slug) || 0;
  used.set(slug, n + 1);
  e.slug = n ? `${slug}-${String.fromCharCode(97 + n)}` : slug;
}

mkdirSync(join(root, "data"), { recursive: true });
writeFileSync(join(root, "data", "cv_entries.json"), JSON.stringify(entries, null, 2) + "\n");

const bySection = {};
for (const e of entries) bySection[e.section] = (bySection[e.section] || 0) + 1;
console.log(`Parsed ${entries.length} entries from ${cvPath}`);
console.log(bySection);
console.log(`  with DOI:    ${entries.filter((e) => e.doi).length}`);
console.log(`  with venue:  ${entries.filter((e) => e.venue).length}`);
console.log(`  authors>1:   ${entries.filter((e) => e.authors.length > 1).length}`);
console.log(`  no title:    ${entries.filter((e) => !e.title).length}`);
console.log(`  accepted/forthcoming (no final details): ${entries.filter((e) => e.status !== "published").length}`);
