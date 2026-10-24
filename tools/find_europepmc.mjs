#!/usr/bin/env node
// Second-pass OA discovery through Europe PMC (https://europepmc.org/RestfulWebService).
//
// For every entry in data/oa.json that is not yet 'hostable' and has a DOI in the CV, look the
// DOI up in Europe PMC. If the record is in PMC, flagged open access (isOpenAccess=Y) and carries
// a Creative Commons licence, add a candidate { source: "europepmc", license, version, url } to
// the entry in data/oa.json and recompute best/status with the same ranking as find_oa.mjs.
// fetch_pdfs.mjs then downloads and verifies it (PDF magic + page-1 title) as for any other source.
//
// The PDF URL comes from the record's own fullTextUrlList (documented Europe PMC field). Each URL
// is probed with a ranged GET and kept only if the bytes start with %PDF-. A response that is a
// bot challenge or login wall is never worked around; that URL is simply not used.
//
// Polite by design: unauthenticated, no email, <= 3 requests/second, 15 s timeouts, a circuit
// breaker per host, and resumable (checked entries are remembered in data/europepmc.json).
//
//   node tools/find_europepmc.mjs [--refresh] [--only SLUG] [--include-inferred] [--limit N]
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { UA, tfetch, tripped, strikes, polite, getJson, norm, similarity, isCC, mergeCandidates, saveJson } from "./lib/oa_common.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entries = JSON.parse(readFileSync(join(root, "data", "cv_entries.json"), "utf8"));
const oaPath = join(root, "data", "oa.json");
const statePath = join(root, "data", "europepmc.json"); // per-slug outcome of this pass (makes reruns resumable)
const oa = JSON.parse(readFileSync(oaPath, "utf8"));
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
const arg = (n) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : null);
const refresh = process.argv.includes("--refresh");
const includeInferred = process.argv.includes("--include-inferred");
const only = arg("--only");
const limit = Number(arg("--limit") || Infinity);

const BASE = process.env.EUROPEPMC_BASE || "https://www.ebi.ac.uk/europepmc/webservices/rest";
const SCHEME = process.env.EUROPEPMC_BASE ? /^https?:/ : /^https:/; // http only when pointed at a local test server
const GAP_MS = 400; // < 3 requests/second
const today = new Date().toISOString().slice(0, 10);

// Europe PMC's `license` field is free text such as "cc by", "cc by-nc-nd", "cc0".
function licenseUrl(raw) {
  const m = (raw || "").toLowerCase().trim().match(/^cc[- ]?(by(?:[- ](?:nc|nd|sa))*|0|zero)\b/);
  if (!m) return null;
  if (/^(0|zero)$/.test(m[1])) return "https://creativecommons.org/publicdomain/zero/1.0/";
  return `https://creativecommons.org/licenses/${m[1].replace(/\s+/g, "-")}/`;
}

// Fetch only the first bytes of a candidate PDF URL and check the magic number.
async function probePdf(url) {
  const host = new URL(url).host;
  if (tripped(host)) return false;
  await polite(host, GAP_MS);
  try {
    const res = await tfetch(url, { headers: { "User-Agent": UA, Accept: "application/pdf", Range: "bytes=0-1023" }, redirect: "follow" });
    if (res.status === 403 || res.status === 429 || res.headers.get("cf-mitigated")) {
      strikes[host] = (strikes[host] || 0) + 3; // bot check or rate limit: leave this host alone for the run
      console.log(`  [${host}] bot check / blocked (${res.status}) — not used, skipping host`);
      return false;
    }
    if (!res.ok || !res.body) return false;
    const reader = res.body.getReader();
    const { value } = await reader.read();
    await reader.cancel().catch(() => {});
    return !!value && Buffer.from(value.subarray(0, 5)).toString("latin1") === "%PDF-";
  } catch {
    return false;
  }
}

async function lookup(e, doi) {
  const q = encodeURIComponent(`DOI:"${doi}"`);
  const j = await getJson(`${BASE}/search?query=${q}&resultType=core&format=json&pageSize=5`, "europepmc", GAP_MS, 3);
  if (!j || j._status || j.errCode) return { error: j ? j._status || j.errCode : "unreachable" };
  const hits = j.resultList?.result || [];
  const pick = hits.find((h) => (h.doi || "").toLowerCase() === doi.toLowerCase() && h.pmcid) || hits.find((h) => (h.doi || "").toLowerCase() === doi.toLowerCase());
  if (!pick) return { outcome: "no-record" };
  const base = { pmcid: pick.pmcid || null, isOpenAccess: pick.isOpenAccess || null, license_raw: pick.license || null, epmc_title: pick.title || null };
  if (!pick.pmcid) return { ...base, outcome: "not-in-pmc" };
  if (pick.isOpenAccess !== "Y") return { ...base, outcome: "not-open-access" };
  const lic = licenseUrl(pick.license);
  if (!lic || !isCC(lic)) return { ...base, outcome: "open-access-no-cc-licence" };
  if (similarity(pick.title, e.title) < 0.7) return { ...base, outcome: "title-mismatch" };
  const urls = (pick.fullTextUrlList?.fullTextUrl || [])
    .filter((u) => u.documentStyle === "pdf" && ["OA", "F"].includes(u.availabilityCode) && SCHEME.test(u.url))
    .map((u) => u.url);
  let pdf = null;
  for (const u of urls) if (await probePdf(u)) { pdf = u; break; }
  return { ...base, outcome: pdf ? "candidate" : "cc-licence-no-pdf-url", license: lic, pdf_url: pdf, tried: urls.length };
}

const targets = entries.filter((e) => {
  const r = oa[e.slug];
  if (!r || r.status === "hostable") return false;
  if (only && e.slug !== only) return false;
  if (!(e.doi || (includeInferred && r.doi_inferred && !r.doi_inferred.needs_review))) return false;
  return refresh || !state[e.slug];
});
console.log(`Europe PMC pass: ${targets.length} entries to check (${Object.keys(state).length} already done)`);
let n = 0, added = 0;
for (const e of targets) {
  if (n >= limit) break;
  if (tripped("europepmc")) { console.log("Europe PMC unavailable (circuit breaker open) — stopping; re-run later to resume."); break; }
  n++;
  const doi = e.doi || oa[e.slug].doi_inferred.doi;
  const res = await lookup(e, doi);
  if (res.error) { console.log(`  ${e.cv_label}: Europe PMC error (${res.error}) — will retry on next run`); continue; }
  state[e.slug] = { doi, checked_at: today, ...res };
  if (res.outcome === "candidate" || res.outcome === "cc-licence-no-pdf-url") {
    const cand = {
      source: "europepmc",
      url: res.pdf_url,
      landing: `https://europepmc.org/article/PMC/${res.pmcid.replace(/^PMC/, "")}`,
      version: "publishedVersion",
      license: res.license,
      pmcid: res.pmcid,
      confidence: res.pdf_url ? 0.9 : 0.6,
      ...(res.pdf_url ? {} : { note: "CC-licensed in PMC; Europe PMC lists no directly downloadable PDF URL" }),
    };
    added += mergeCandidates(oa[e.slug], [cand]);
    console.log(`  ${e.cv_label}: ${res.pmcid} ${res.license_raw} -> ${oa[e.slug].status}`);
  }
  saveJson(statePath, state);
  saveJson(oaPath, oa);
  if (n % 20 === 0) console.log(`  ${n}/${targets.length}`);
}
saveJson(statePath, state);
const tally = {};
for (const s of Object.values(state)) tally[s.outcome] = (tally[s.outcome] || 0) + 1;
console.log(`Done: ${n} looked up, ${added} candidate(s) added. Outcomes so far:`, tally);
