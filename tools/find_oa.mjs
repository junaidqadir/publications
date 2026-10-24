#!/usr/bin/env node
// Discover legitimate open-access copies for every CV entry.
//
// Sources (all public, no credentials): arXiv, Semantic Scholar, Crossref,
// OpenAlex. Writes data/oa.json, resumable (re-run to continue; --refresh to redo).
//
// Policy: this tool only *discovers* locations. fetch_pdfs.mjs decides what may be
// hosted in the repo (CC-licensed publisher copies and author-deposited preprints)
// and what must stay a link-out. Nothing here bypasses paywalls, logins or bot checks.
//
//   node tools/find_oa.mjs [--refresh] [--only SLUG]
//   node tools/find_oa.mjs --retry-flagged   re-query Semantic Scholar, Crossref and OpenAlex for entries with
//                                            status 'oa-flagged-no-pdf-url' and merge anything new into oa.json
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { UA, sleep, tfetch, strikes, tripped, polite, getJson, norm, similarity, isCC, score, statusOf, mergeCandidates } from "./lib/oa_common.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entries = JSON.parse(readFileSync(join(root, "data", "cv_entries.json"), "utf8"));
const outPath = join(root, "data", "oa.json");
const overridesPath = join(root, "data", "overrides.json"); // hand-curated: { slug: { url, license, version, note } }
const results = existsSync(outPath) ? JSON.parse(readFileSync(outPath, "utf8")) : {};
const overrides = existsSync(overridesPath) ? JSON.parse(readFileSync(overridesPath, "utf8")) : {};
const refresh = process.argv.includes("--refresh");
const retryFlagged = process.argv.includes("--retry-flagged");
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;

// ---------- sources ----------
async function fromArxiv(e) {
  const out = [];
  const known = e.arxiv || (e.links || []).map((u) => u.match(/arxiv\.org\/(?:abs|pdf)\/([\d.]+)/)?.[1]).find(Boolean);
  const q = known
    ? `id_list=${known}`
    : `search_query=ti:%22${encodeURIComponent(norm(e.title).split(" ").slice(0, 14).join(" "))}%22&max_results=3`;
  await polite("arxiv", 3200);
  try {
    if (tripped("arxiv")) return out;
    const res = await tfetch(`https://export.arxiv.org/api/query?${q}`, { headers: { "User-Agent": UA } });
    if (res.status === 429) strikes.arxiv = (strikes.arxiv || 0) + 1;
    if (!res.ok) return out;
    const xml = await res.text();
    for (const ent of xml.split("<entry>").slice(1)) {
      const title = (ent.match(/<title>([\s\S]*?)<\/title>/) || [])[1]?.replace(/\s+/g, " ").trim();
      const id = (ent.match(/<id>https?:\/\/arxiv\.org\/abs\/([^<]+?)(?:v\d+)?<\/id>/) || [])[1];
      const authors = [...ent.matchAll(/<name>([^<]+)<\/name>/g)].map((m) => m[1]);
      if (!id) continue;
      const sim = similarity(title, e.title);
      const ours = authors.some((a) => /qadir/i.test(a));
      if ((known && id.startsWith(known)) || (sim >= 0.8 && ours)) {
        out.push({ source: "arxiv", url: `https://arxiv.org/pdf/${id}`, landing: `https://arxiv.org/abs/${id}`, version: "preprint", license: "arXiv", confidence: known ? 1 : sim });
      }
    }
  } catch {}
  return out;
}

async function fromSemanticScholar(e) {
  const out = [];
  const fields = "title,openAccessPdf,externalIds,isOpenAccess";
  let j = null;
  if (e.doi) {
    j = await getJson(`https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(e.doi)}?fields=${fields}`, "s2", 1300, 2);
  }
  if ((!j || j._status) && e.title) {
    const s = await getJson(`https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(e.title)}&limit=3&fields=${fields}`, "s2", 1300, 2);
    const hit = s?.data?.find((p) => similarity(p.title, e.title) >= 0.85);
    if (hit) j = hit;
  }
  if (j && !j._status) {
    const ax = j.externalIds?.ArXiv;
    if (ax) out.push({ source: "s2-arxiv-id", url: `https://arxiv.org/pdf/${ax}`, landing: `https://arxiv.org/abs/${ax}`, version: "preprint", license: "arXiv", confidence: 0.95 });
    const oa = j.openAccessPdf;
    if (oa?.url) out.push({ source: "semanticscholar", url: oa.url, landing: oa.url, version: /GOLD|HYBRID/i.test(oa.status || "") ? "publishedVersion" : "unknown", license: oa.license || null, oaStatus: oa.status || null, confidence: 0.9 });
  }
  return out;
}

async function fromCrossref(e) {
  const out = [];
  if (!e.doi) return out;
  const j = await getJson(`https://api.crossref.org/works/${encodeURIComponent(e.doi)}`, "crossref", 200);
  const m = j?.message;
  if (!m) return out;
  const cc = (m.license || []).find((l) => isCC(l.URL));
  for (const l of m.link || []) {
    // Crossref often files publisher PDF links as content-type "unspecified"; fetch_pdfs.mjs still verifies the bytes.
    if (/pdf|unspecified/i.test(l["content-type"] || "") && cc) {
      out.push({ source: "crossref-link", url: l.URL, landing: `https://doi.org/${e.doi}`, version: cc["content-version"] === "am" ? "acceptedVersion" : "publishedVersion", license: cc.URL, confidence: 0.85 });
    }
  }
  if (cc) out.push({ source: "crossref-license", url: null, landing: `https://doi.org/${e.doi}`, version: "publishedVersion", license: cc.URL, confidence: 0.6, note: "CC-licensed at the publisher; PDF URL not given by Crossref" });
  return out;
}

async function fromOpenAlex(e) {
  const out = [];
  if (!e.doi) return out;
  const j = await getJson(`https://api.openalex.org/works/doi:${encodeURIComponent(e.doi)}`, "openalex", 250, 1);
  if (!j || j._status || j.error) return out;
  for (const loc of j.locations || []) {
    if (loc.pdf_url || loc.landing_page_url) {
      out.push({ source: "openalex", url: loc.pdf_url || null, landing: loc.landing_page_url || null, version: loc.version || "unknown", license: loc.license || null, host: loc.source?.display_name || null, confidence: 0.8 });
    }
  }
  return out;
}

// Infer a missing DOI from Crossref by title + first-author surname. Never written back
// into the CV automatically: surfaced in data/oa.json (doi_inferred) for human review.
async function inferDoi(e) {
  if (!e.title || e.section === "informal") return null;
  const j = await getJson(
    `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(e.title)}&query.author=Qadir&rows=8&select=DOI,title,author,issued,container-title,type`,
    "crossref", 200, 3
  );
  const PREPRINT_DOI = /^10\.(36227|2139|35542|31219|48550|20944|21203)\//; // TechRxiv, SSRN, OSF, ... , arXiv-DOI, Preprints.org, Research Square
  const scored = [];
  for (const it of j?.message?.items || []) {
    const sim = similarity(it.title?.[0], e.title);
    const authorHit = (it.author || []).some((a) => /qadir/i.test(a.family || ""));
    const y = it.issued?.["date-parts"]?.[0]?.[0] || null;
    const yearOk = !e.year || !y || Math.abs(y - e.year) <= 1;
    if (sim >= 0.6 && authorHit && yearOk) {
      scored.push({ doi: it.DOI, title: it.title[0], venue: it["container-title"]?.[0] || null, year: y, similarity: Number(sim.toFixed(2)), preprint: PREPRINT_DOI.test(it.DOI) });
    }
  }
  if (!scored.length) return null;
  const published = scored.filter((x) => !x.preprint).sort((a, b) => b.similarity - a.similarity);
  const preprints = scored.filter((x) => x.preprint).map((x) => x.doi);
  const best = published[0] || scored.sort((a, b) => b.similarity - a.similarity)[0];
  return { ...best, needs_review: best.similarity < 0.9, preprint_dois: preprints };
}

// ---------- main ----------
const todo = entries.filter((e) =>
  retryFlagged ? results[e.slug]?.status === "oa-flagged-no-pdf-url" && (!only || e.slug === only)
    : only ? e.slug === only : refresh || !results[e.slug]);
console.log(`Discovering OA for ${todo.length} of ${entries.length} entries`);
let n = 0;
for (const e of todo) {
  n++;
  if (retryFlagged) {
    // Only the keyless JSON APIs; candidates from other passes (e.g. Europe PMC) are kept and merged.
    const rec = results[e.slug];
    const doi = e.doi || rec.doi_inferred?.doi;
    if (!doi) continue;
    const fresh = [];
    for (const f of [fromSemanticScholar, fromCrossref, fromOpenAlex]) {
      try { fresh.push(...(await f({ ...e, doi }))); } catch {}
    }
    const added = mergeCandidates(rec, fresh);
    rec.retried_at = new Date().toISOString().slice(0, 10);
    writeFileSync(outPath, JSON.stringify(results, null, 2) + "\n");
    if (added || n % 10 === 0 || n === todo.length) console.log(`  ${n}/${todo.length}  ${e.cv_label}: +${added} candidate(s) -> ${rec.status}`);
    continue;
  }
  let cands = [];
  if (overrides[e.slug]?.url) {
    const o = overrides[e.slug];
    cands.push({ source: "override", url: o.url, landing: o.landing || o.url, version: o.version || "unknown", license: o.license || null, confidence: 2, note: o.note });
  }
  let inferred = null;
  let ee = e;
  if (!e.doi) {
    try { inferred = await inferDoi(e); } catch {}
    if (inferred) ee = { ...e, doi: inferred.doi };
  }
  for (const f of [fromArxiv, fromSemanticScholar, fromCrossref, fromOpenAlex]) {
    try {
      cands.push(...(await f(ee)));
    } catch (err) {
      /* a source failing must never stop the run */
    }
  }
  for (const pd of inferred?.preprint_dois || []) {
    cands.push({ source: "preprint-doi", url: null, landing: `https://doi.org/${pd}`, version: "preprint", license: null, confidence: 0.5, note: "Preprint DOI; download manually if no direct PDF URL" });
  }
  // de-dupe by url
  const seen = new Set();
  cands = cands.filter((c) => {
    const k = c.url || `${c.source}:${c.landing}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).sort((a, b) => score(b) - score(a));

  const best = cands.find((c) => c.url) || null;
  const status = statusOf(cands);
  results[e.slug] = { cv_label: e.cv_label, title: e.title, doi: e.doi, ...(inferred ? { doi_inferred: inferred } : {}), status, best, candidates: cands.slice(0, 6), checked_at: new Date().toISOString().slice(0, 10) };
  writeFileSync(outPath, JSON.stringify(results, null, 2) + "\n");
  if (n % 10 === 0 || n === todo.length) console.log(`  ${n}/${todo.length}  (last: ${e.cv_label} -> ${status})`);
}
const tally = {};
for (const r of Object.values(results)) tally[r.status] = (tally[r.status] || 0) + 1;
console.log("Summary:", tally);
