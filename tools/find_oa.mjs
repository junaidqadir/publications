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
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entries = JSON.parse(readFileSync(join(root, "data", "cv_entries.json"), "utf8"));
const outPath = join(root, "data", "oa.json");
const overridesPath = join(root, "data", "overrides.json"); // hand-curated: { slug: { url, license, version, note } }
const results = existsSync(outPath) ? JSON.parse(readFileSync(outPath, "utf8")) : {};
const overrides = existsSync(overridesPath) ? JSON.parse(readFileSync(overridesPath, "utf8")) : {};
const refresh = process.argv.includes("--refresh");
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;

const UA = "junaidqadir-publications-archive/1.0 (+https://github.com/junaidqadir/publications)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tfetch = (url, opts = {}) => fetch(url, { ...opts, signal: AbortSignal.timeout(15000) });
// Circuit breaker: a source that keeps rate-limiting us is skipped for the rest of the run.
const strikes = {};
const tripped = (host) => (strikes[host] || 0) >= 3;
let lastCall = {};
async function polite(host, gapMs) {
  const wait = (lastCall[host] || 0) + gapMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall[host] = Date.now();
}

async function getJson(url, host, gapMs, tries = 4) {
  if (tripped(host)) return null;
  for (let i = 0; i < tries; i++) {
    await polite(host, gapMs);
    try {
      const res = await tfetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
      if (res.status === 429 || res.status === 402 || res.status === 403 || res.status >= 500) {
        strikes[host] = (strikes[host] || 0) + 1;
        if (tripped(host)) { console.log(`  [${host}] rate-limited/blocked — skipping this source from now on`); return null; }
        await sleep(1500 * 2 ** i);
        continue;
      }
      if (!res.ok) return { _status: res.status };
      return await res.json();
    } catch {
      await sleep(1500 * 2 ** i);
    }
  }
  return null;
}

const norm = (t) => (t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const words = (t) => new Set(norm(t).split(" ").filter((w) => w.length > 2));
function similarity(a, b) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

const isCC = (lic) => /creativecommons\.org|^cc[- ]by/i.test(lic || "");
const PREPRINT_HOSTS = /arxiv\.org|ssrn\.com|osf\.io|techrxiv\.org|zenodo\.org|researchsquare\.com|preprints\.org|hal\.science|hal\.archives-ouvertes\.fr|biorxiv\.org|medrxiv\.org/i;

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
    if (/pdf/i.test(l["content-type"] || "") && cc) {
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

// ---------- ranking ----------
function score(c) {
  let s = c.confidence || 0;
  if (c.url) s += 0.5;
  if (/arxiv/i.test(c.source) || /arxiv\.org/.test(c.url || "")) s += 0.6;
  else if (isCC(c.license)) s += 0.5;
  else if (PREPRINT_HOSTS.test(c.url || "")) s += 0.4;
  return s;
}

function hostable(c) {
  if (!c.url) return false;
  if (/arxiv\.org/.test(c.url)) return true; // author-posted preprint
  if (isCC(c.license)) return true; // open licence permits redistribution
  if (PREPRINT_HOSTS.test(c.url)) return true; // author-deposited preprint servers
  return false;
}

// ---------- main ----------
const todo = entries.filter((e) => (only ? e.slug === only : refresh || !results[e.slug]));
console.log(`Discovering OA for ${todo.length} of ${entries.length} entries`);
let n = 0;
for (const e of todo) {
  n++;
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
  const status = !best
    ? cands.length ? "oa-flagged-no-pdf-url" : "none-found"
    : hostable(best) ? "hostable" : "free-to-read-link-only";
  results[e.slug] = { cv_label: e.cv_label, title: e.title, doi: e.doi, ...(inferred ? { doi_inferred: inferred } : {}), status, best, candidates: cands.slice(0, 6), checked_at: new Date().toISOString().slice(0, 10) };
  writeFileSync(outPath, JSON.stringify(results, null, 2) + "\n");
  if (n % 10 === 0 || n === todo.length) console.log(`  ${n}/${todo.length}  (last: ${e.cv_label} -> ${status})`);
}
const tally = {};
for (const r of Object.values(results)) tally[r.status] = (tally[r.status] || 0) + 1;
console.log("Summary:", tally);
