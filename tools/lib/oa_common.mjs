// Shared helpers for the open-access discovery tools (find_oa, find_europepmc, retry_flagged).
// Ranking and the hostable() policy live here once so every discovery tool applies the same rules.
import { writeFileSync } from "node:fs";

export const UA = "junaidqadir-publications-archive/1.0 (+https://github.com/junaidqadir/publications)";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const tfetch = (url, opts = {}) => fetch(url, { ...opts, signal: AbortSignal.timeout(15000) });

// Circuit breaker: a source that keeps rate-limiting us is skipped for the rest of the run.
export const strikes = {};
export const tripped = (host) => (strikes[host] || 0) >= 3;
const lastCall = {};
export async function polite(host, gapMs) {
  const wait = (lastCall[host] || 0) + gapMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall[host] = Date.now();
}

export async function getJson(url, host, gapMs, tries = 4) {
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

export const norm = (t) => (t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const words = (t) => new Set(norm(t).split(" ").filter((w) => w.length > 2));
export function similarity(a, b) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

// ---------- ranking and hosting policy ----------
export const isCC = (lic) => /creativecommons\.org|^cc[- ]by/i.test(lic || "");
export const PREPRINT_HOSTS = /arxiv\.org|ssrn\.com|osf\.io|techrxiv\.org|zenodo\.org|researchsquare\.com|preprints\.org|hal\.science|hal\.archives-ouvertes\.fr|biorxiv\.org|medrxiv\.org/i;

export function score(c) {
  let s = c.confidence || 0;
  if (c.url) s += 0.5;
  if (/arxiv/i.test(c.source) || /arxiv\.org/.test(c.url || "")) s += 0.6;
  else if (isCC(c.license)) s += 0.5;
  else if (PREPRINT_HOSTS.test(c.url || "")) s += 0.4;
  return s;
}

export function hostable(c) {
  if (!c.url) return false;
  if (/arxiv\.org/.test(c.url)) return true; // author-posted preprint
  if (isCC(c.license)) return true; // open licence permits redistribution
  if (PREPRINT_HOSTS.test(c.url)) return true; // author-deposited preprint servers
  return false;
}

export const statusOf = (cands) => {
  const best = cands.find((c) => c.url) || null;
  return !best ? (cands.length ? "oa-flagged-no-pdf-url" : "none-found") : hostable(best) ? "hostable" : "free-to-read-link-only";
};

// Merge new candidates into an oa.json record and recompute best/status with the shared ranking.
// Candidates already present (same url, or same source+landing when url-less) are kept as they are.
export function mergeCandidates(rec, fresh) {
  const key = (c) => c.url || `${c.source}:${c.landing}`;
  const have = new Set(rec.candidates.map(key));
  const added = fresh.filter((c) => !have.has(key(c)));
  const cands = [...rec.candidates, ...added].sort((a, b) => score(b) - score(a));
  rec.candidates = cands.slice(0, 8);
  rec.best = cands.find((c) => c.url) || null;
  rec.status = statusOf(cands);
  return added.length;
}

export const saveJson = (path, obj) => writeFileSync(path, JSON.stringify(obj, null, 2) + "\n");
