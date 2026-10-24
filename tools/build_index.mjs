#!/usr/bin/env node
// Merge CV entries + OA discovery + downloaded PDFs + tags into the files the websites read:
//   index.json   (source of truth for the sites; one record per CV entry)
//   MISSING.md   (what is not archived, and exactly why / what to do)
//   REVIEW.md    (CV-vs-reality discrepancies surfaced while checking: wrong titles, missing DOIs, ...)
//   README.md    (status line + counts)
//
//   node tools/build_index.mjs
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p, d) => (existsSync(join(root, p)) ? JSON.parse(readFileSync(join(root, p), "utf8")) : d);
const entries = rd("data/cv_entries.json", []);
const oa = rd("data/oa.json", {});
const manifest = rd("data/pdf_manifest.json", {});
const preprintLinks = rd("data/preprint_links.json", {}); // { slug: { url, host } } author-posted preprints on SSRN/OSF/etc. (linked, not mirrored)
const featuredList = rd("data/featured.json", []); // extra featured slugs (besides overrides.json)
const accessNotes = rd("data/access_notes.json", {}); // { slug: "why no PDF is hosted / how to get a copy" }
const curated = rd("data/curated_themes.json", {}); // { theme: [slug,...] } hand-picked theme membership (e.g. multiplexity)
const overrides = rd("data/overrides.json", {}); // { slug: { tags:[], themes:[], featured:bool, note, doi } }
const fetchErrors = rd("data/fetch_errors.json", {});

const norm = (t) => (t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// ---------- tagging: transparent keyword rules (human-reviewable; override per paper in overrides.json) ----------
const RULES = [
  [/generative ai|chatgpt|large language model|\bllms?\b|\bgpt\b|foundation (ai )?models?|agentic|multi-agent/, ["generative-ai"], ["ai"]],
  [/adversarial|robust(ness)?|attack/, ["adversarial-ml"], ["ai", "ai-security"]],
  [/safety|safe and|trustworth|red.team|jailbreak|alignment|backdoor|poison|malware|threat|vulnerab|defen[cs]e/, ["ai-safety"], ["ai-security"]],
  [/federated learning/, ["federated-learning"], ["ai", "ai-security", "ml"]],
  [/reinforcement learning/, ["reinforcement-learning"], ["ai", "ml"]],
  [/deep learning|neural network|machine learning|\bml\b|learning-based/, ["machine-learning"], ["ai", "ml"]],
  [/\bai\b|artificial intelligence|responsible ai|trustworthy|human-centered|explainable|accountab/, ["responsible-ai"], ["ai"]],
  [/privacy|security|cyber|intrusion|blockchain|misinformation|fake news|deepfake|fake/, ["security-privacy"], ["ai-security"]],
  [/education|learning and teaching|pedagog|teaching|classroom|student|curricul|engineering ethics|\bobe\b|outcome[- ]based/, ["education"], ["education"]],
  [/multiplex|marātib|systemics|systems thinking/, ["multiplexity"], ["multiplexity"]],
  [/islam(?!abad)|ihsan|iḥsān|quran|qur.an|hadith|ghaz|shariah|maqasid|virtue ethics|virtue-based/, ["islamic-ethics"], ["ihsan-ethics"]],
  [/ethic|moral|normative|governance|regulat/, ["ai-ethics"], ["ai-ethics"]],
  [/responsible ai|trustworth(y|iness)|human-centered|human-centred|accountab|explainab|fairness|\bbias\b|\bsafe(ty)?\b|harms?\b/, ["responsible-ai"], ["ai-ethics"]],
  [/governance|regulat|\bpolic(y|ies)\b|p3722|compliance/, ["ai-governance"], ["ai-ethics"]],
  [/health|medical|clinical|surg|patient|disease|diagnos|dental|retinal|tumor|epilep|cancer|\bmri\b|biomedical|sonograph|diabetes|covid|digital twin/, ["healthcare"], ["health-psychology"]],
  [/emotion|psycholog|mental|well-?being|ocd|spiritual care/, ["psychology"], ["health-psychology"]],
  [/speech|audio|acoustic|\bvoice\b|reciter/, ["speech-audio"], ["ml"]],
  [/\bimages?\b|computer vision|segmentation|\bvideos?\b|autonomous (driving|vehicle)|endoscop|retinal|\bmri\b|detection in/, ["computer-vision"], ["ml"]],
  [/metaverse|extended reality|virtual reality|augmented reality|\bxr\b|avatar/, ["metaverse-xr"], []],
  [/(?<!neural )(?<!social )(?<!deep )\bnetworks?\b|wireless|\biot\b|internet of|\b5g\b|\b6g\b|cognitive radio|routing|broadcast|\bmesh|cellular|\bsdn\b|multipath|spectrum|\btor\b|internet access|\bmac\b/, ["networking"], ["networks-ict4d"]],
  [/smart (city|cities|building)|traffic|urban|energy|sustainab|\bsdg/, ["smart-cities-sustainability"], ["sustainability"]],
  [/development|rural|developing (world|countries|region)|ict4d|humanitarian|crisis|low-literate|big data for/, ["ict4d"], ["networks-ict4d"]],
  [/quantum/, ["quantum"], []],
  [/bibliometric|systematic (review|literature)|\bsurvey\b|\breview\b|comprehensive (review|examination)/, ["survey-review"], []],
];
function classify(e) {
  const title = e.title.toLowerCase();
  const t = `${title} ${(e.venue || "").toLowerCase()}`;
  const tags = new Set(), themes = new Set();
  for (const [re, tg, th] of RULES) {
    const hay = tg.includes("survey-review") ? title : t; // "Review"/"Survey" in a venue name says nothing about the paper
    if (re.test(hay)) { tg.forEach((x) => tags.add(x)); th.forEach((x) => themes.add(x)); }
  }
  if (/Surveys|Computer Science Review|Computing Surveys/i.test(e.venue || "")) tags.add("survey-review");
  return { tags: [...tags], themes: [...themes] };
}

// ---------- BibTeX ----------
const bibName = (a) => {
  const parts = a.replace(/\./g, ". ").replace(/\s+/g, " ").trim().split(" ");
  const sur = parts.pop();
  return parts.length ? `${sur}, ${parts.join(" ")}` : sur;
};
const bibEsc = (s) => (s || "").replace(/&/g, "\\&").replace(/%/g, "\\%").replace(/_/g, "\\_");
function bibtex(e, key) {
  const type = { journal: "article", conference: "inproceedings", "book-chapter": "incollection", misc: "misc", informal: "misc" }[e.section] || "misc";
  const f = [];
  f.push(`  title     = {{${bibEsc(e.title)}}}`);
  f.push(`  author    = {${e.authors.map(bibName).join(" and ")}}`);
  if (e.venue) f.push(`  ${type === "article" ? "journal" : type === "misc" ? "howpublished" : "booktitle"} = {${bibEsc(e.venue)}}`);
  if (e.volume) f.push(`  volume    = {${e.volume}}`);
  if (e.issue) f.push(`  number    = {${e.issue}}`);
  if (e.pages) f.push(`  pages     = {${e.pages.replace("–", "--")}}`);
  if (e.year) f.push(`  year      = {${e.year}}`);
  if (e.doi) f.push(`  doi       = {${e.doi}}`);
  return `@${type}{${key},\n${f.join(",\n")}\n}`;
}

// ---------- assemble ----------
const keysUsed = new Map();
const out = entries.map((e) => {
  const ov = overrides[e.slug] || {};
  const r = oa[e.slug];
  const m = manifest[e.slug];
  const { tags, themes } = classify(e);
  const doi = ov.doi || e.doi || null;
  const sur = ((e.authors[0] || "qadir").split(/\s+/).pop() || "qadir").toLowerCase().replace(/[^a-z]/g, "");
  let key = `${sur}${e.year ?? ""}${(norm(e.title).split(" ").find((w) => w.length > 3) || "x")}`;
  const n = keysUsed.get(key) || 0; keysUsed.set(key, n + 1); if (n) key += String.fromCharCode(97 + n);
  const rec = {
    slug: e.slug,
    cv_label: e.cv_label,
    title: e.title,
    authors: e.authors,
    year: e.year,
    venue: e.venue,
    volume: e.volume,
    issue: e.issue,
    pages: e.pages,
    doi,
    section: e.section,
    status: e.status === "published" ? "final" : e.status,
    awards: e.awards,
    best_paper_award: e.awards.some((a) => /best paper/i.test(a)),
    tags: [...new Set([...(ov.tags || []), ...tags])],
    themes: [...new Set([...(ov.themes || []), ...Object.entries(curated).filter(([k, v]) => !k.startsWith("_") && v.includes(e.slug)).map(([k]) => k), ...themes])],
    featured: ov.featured ?? featuredList.includes(e.slug),
    access_note: accessNotes[e.slug] || null,
    preprint_url: preprintLinks[e.slug]?.url || null,
    preprint_host: preprintLinks[e.slug]?.host || null,
    links: e.links || [],
    // open-access copy
    pdf: m ? m.path : null,
    pdf_version: m ? m.version : null,
    pdf_license: m ? m.license : null,
    oa_url: r?.best?.landing || r?.best?.url || null,
    oa_status: r?.status || "unchecked",
    bibtex: bibtex({ ...e, doi }, key),
  };
  return rec;
});

out.sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || b.cv_label.localeCompare(a.cv_label, undefined, { numeric: true }));
writeFileSync(join(root, "index.json"), JSON.stringify(out, null, 2) + "\n");

// ---------- MISSING.md ----------
const have = out.filter((x) => x.pdf);
const missing = out.filter((x) => !x.pdf);
const why = (x) => {
  const r = oa[x.slug];
  const err = fetchErrors[x.slug]?.message;
  if (err) return `OA copy exists but could not be fetched automatically (${err}) — download it in a browser`;
  if (r?.status === "free-to-read-link-only") return "free to read, but no open licence — linked, not hosted";
  if (r?.status === "oa-flagged-no-pdf-url") return "open copy flagged, but no direct PDF URL — see links";
  if (x.status !== "final") return "not yet published (accepted/forthcoming) — add the accepted manuscript if the publisher allows";
  if (x.section === "informal" || x.section === "misc") return "no DOI / not a typical archival item";
  return "no open copy found — closed access; add your accepted manuscript if the publisher permits self-archiving";
};
const link = (x) => (x.doi ? `[doi](https://doi.org/${x.doi})` : "") + (x.oa_url && x.oa_url !== `https://doi.org/${x.doi}` ? ` [open copy](${x.oa_url})` : "");
let md = `# Not archived\n\nGenerated by \`tools/build_index.mjs\` — **${have.length} of ${out.length}** entries have a PDF in this repository.\n\nThe CV is the source of truth; this archive trails it. Only legitimately shareable copies are hosted (author-posted preprints, openly-licensed publisher copies, and accepted manuscripts where the publisher permits). Nothing here bypasses paywalls or bot checks. To add a PDF you are entitled to share, drop it at \`pdf/<year>/<slug>.pdf\` and add a line to \`data/overrides.json\`.\n\n`;
for (const section of ["journal", "conference", "book-chapter", "misc", "informal"]) {
  const rows = missing.filter((x) => x.section === section);
  if (!rows.length) continue;
  md += `\n## ${section} (${rows.length})\n\n| CV | Year | Title | Links | Why / what to do |\n|---|---|---|---|---|\n`;
  for (const x of rows) md += `| ${x.cv_label} | ${x.year ?? ""} | ${x.title.replace(/\|/g, "/")} | ${link(x)} | ${why(x)} |\n`;
}
writeFileSync(join(root, "MISSING.md"), md);

// ---------- REVIEW.md (the "checking each PDF against the CV found an error" file) ----------
let rv = `# CV entries to double-check\n\nSurfaced automatically while matching the CV against Crossref and the downloaded PDFs. Fix in \`QadirCV.tex\`, then re-run \`tools/parse_cv.mjs\`.\n\n`;
const inferred = Object.entries(oa).filter(([, r]) => r.doi_inferred);
rv += `## DOIs found for entries that have none in the CV (${inferred.length})\n\n| CV | CV title | Crossref title | Suggested DOI | Match |\n|---|---|---|---|---|\n`;
for (const [, r] of inferred) rv += `| ${r.cv_label} | ${r.title.replace(/\|/g, "/")} | ${r.doi_inferred.title.replace(/\|/g, "/")} | [${r.doi_inferred.doi}](https://doi.org/${r.doi_inferred.doi}) | ${r.doi_inferred.needs_review ? "**titles differ — review**" : "title matches"} |\n`;
const titleDiff = inferred.filter(([, r]) => r.doi_inferred.needs_review);
rv += `\n## Pending / unfinished entries (${out.filter((x) => x.status !== "final").length})\n\n`;
for (const x of out.filter((x) => x.status !== "final")) rv += `- ${x.cv_label} (${x.status}) ${x.title} — ${x.venue}\n`;
rv += `\n## Titles that differ from the published record (${titleDiff.length})\n\n`;
for (const [, r] of titleDiff) rv += `- **${r.cv_label}**: CV says “${r.title}” but the published title is “${r.doi_inferred.title}” (${r.doi_inferred.venue || "venue ?"}, ${r.doi_inferred.year}).\n`;
writeFileSync(join(root, "REVIEW.md"), rv);

// ---------- README status line ----------
const byYear = {};
for (const x of out) { byYear[x.year] = byYear[x.year] || { all: 0, pdf: 0 }; byYear[x.year].all++; if (x.pdf) byYear[x.year].pdf++; }
const bySection = (s) => out.filter((x) => x.section === s);
const readme = `# Publications — Junaid Qadir

**${have.length} / ${out.length} PDFs archived.** An organized, regularly synced archive of my publications, derived from my CV.

- [\`index.json\`](index.json) — every publication with authors, venue, DOI, tags, BibTeX and (where shareable) a PDF path
- [\`pdf/\`](pdf/) — open-access / author copies, filed by year
- [\`MISSING.md\`](MISSING.md) — what is not archived, and why
- [\`REVIEW.md\`](REVIEW.md) — CV entries worth double-checking
- Browse and search on the website: <https://junaidqadir.com/publications> (placeholder domain)

| Type | Entries | With PDF |
|---|---|---|
${["journal", "conference", "book-chapter", "misc", "informal"].map((s) => `| ${s} | ${bySection(s).length} | ${bySection(s).filter((x) => x.pdf).length} |`).join("\n")}

## What is hosted here, and what is not

I host only copies I am entitled to share: **author-posted preprints** (arXiv, SSRN, OSF, TechRxiv, …), **publisher versions under an open (Creative Commons) licence**, and **accepted manuscripts where the publisher's self-archiving policy allows**. Every file records its source, version and licence in \`data/pdf_manifest.json\`. For closed-access papers this repository links to the publisher (DOI) instead. Copyright in each paper remains with its owner; the version of record is always the DOI.

## How it works

\`\`\`
QadirCV.tex ─ tools/parse_cv.mjs ─▶ data/cv_entries.json
                tools/find_oa.mjs ─▶ data/oa.json          (arXiv, Semantic Scholar, Crossref, OpenAlex, Europe PMC)
              tools/fetch_pdfs.mjs ─▶ pdf/<year>/<slug>.pdf + data/pdf_manifest.json   (verifies page 1 title)
              tools/build_index.mjs ─▶ index.json, MISSING.md, REVIEW.md, README.md
\`\`\`

The CV stays canonical: a paper enters the archive only when it is in the CV. Re-sync after editing the CV with \`npm run sync -- /path/to/QadirCV.tex\`.
`;
writeFileSync(join(root, "README.md"), readme);

console.log(`index.json: ${out.length} entries | PDFs: ${have.length} | tags on ${out.filter((x) => x.tags.length).length} | DOIs ${out.filter((x) => x.doi).length}`);
console.log(`REVIEW.md: ${inferred.length} inferred DOIs (${titleDiff.length} with differing titles)`);
