#!/usr/bin/env node
// For CV entries that have no DOI, search Crossref (and DataCite for preprints) for the DOI of the published version.
// A candidate is "high" confidence only if: title similarity >= 0.9, J. Qadir is an author, and the year is within +-1.
// Output: data/doi_candidates.json (reviewed by a human before any DOI is written into the CV). No personal email is sent.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const idx = JSON.parse(readFileSync(join(root, "index.json"), "utf8"));
const todo = idx.filter((e) => !e.doi);
const norm = (t) => (t || "").toLowerCase().replace(/<[^>]+>/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
const words = (t) => new Set(norm(t).split(" ").filter((w) => w.length > 2));
function sim(a, b) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let n = 0; for (const w of A) if (B.has(w)) n++;
  return n / Math.max(A.size, B.size);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = async (u) => { const r = await fetch(u, { signal: AbortSignal.timeout(25000), headers: { "User-Agent": "publications-archive/1.0 (academic CV sync)" } }); if (!r.ok) throw new Error(r.status); return r.json(); };

const out = {};
for (const e of todo) {
  const cands = [];
  try {
    const q = new URLSearchParams({ "query.bibliographic": e.title, "query.author": "Qadir", rows: "8", select: "DOI,title,author,issued,container-title,type,publisher,page,volume" });
    const j = await J(`https://api.crossref.org/works?${q}`);
    for (const w of j.message.items || []) {
      const t = (w.title || [""])[0];
      const authors = (w.author || []).map((a) => `${a.given || ""} ${a.family || ""}`);
      const hasQ = authors.some((a) => /qadir/i.test(a));
      const y = w.issued?.["date-parts"]?.[0]?.[0] ?? null;
      cands.push({ doi: w.DOI, title: t, year: y, type: w.type, container: (w["container-title"] || [""])[0], publisher: w.publisher, qadir: hasQ, sim: +sim(e.title, t).toFixed(2), src: "crossref" });
    }
  } catch (err) { cands.push({ error: "crossref " + err.message }); }
  await sleep(350);
  try {
    const j = await J(`https://api.datacite.org/dois?query=${encodeURIComponent('titles.title:"' + e.title.replace(/"/g, "") + '"')}&page%5Bsize%5D=5`);
    for (const d of j.data || []) {
      const a = d.attributes; const t = (a.titles || [{}])[0].title || "";
      cands.push({ doi: a.doi, title: t, year: a.publicationYear, type: a.types?.resourceTypeGeneral, container: a.container?.title || a.publisher, qadir: (a.creators || []).some((c) => /qadir/i.test(c.name || "")), sim: +sim(e.title, t).toFixed(2), src: "datacite" });
    }
  } catch (err) { /* datacite is optional */ }
  await sleep(350);
  const ok = cands.filter((c) => c.doi).sort((a, b) => (b.qadir - a.qadir) || (b.sim - a.sim));
  const best = ok[0];
  const yearOk = best && e.year && best.year && Math.abs(best.year - e.year) <= 1;
  const conf = best && best.sim >= 0.9 && best.qadir && yearOk ? "high" : best && best.sim >= 0.7 && best.qadir ? "medium" : best && best.sim >= 0.85 ? "low" : "none";
  out[e.cv_label] = { slug: e.slug, title: e.title, year: e.year, venue: e.venue, status: e.status, confidence: conf, best: conf === "none" ? null : best, others: ok.slice(1, 3) };
  process.stdout.write(`${e.cv_label} ${conf} ${best?.doi || ""}\n`);
}
writeFileSync(join(root, "data", "doi_candidates.json"), JSON.stringify(out, null, 2));
const c = Object.values(out).reduce((m, x) => ((m[x.confidence] = (m[x.confidence] || 0) + 1), m), {});
console.log("SUMMARY", c);
