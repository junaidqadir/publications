#!/usr/bin/env node
// Download the legitimately shareable PDFs found by find_oa.mjs into pdf/<year>/<slug>.pdf.
//
// What is hosted in this repo (the "acceptable standard practice"):
//   * author-posted preprints (arXiv, SSRN, OSF, TechRxiv, Zenodo, ...) — version "preprint"
//   * publisher copies under an open licence (Creative Commons)        — version "publishedVersion"
//   * anything the author explicitly whitelists in data/overrides.json  — e.g. an accepted manuscript
//     where the publisher's green-OA policy allows self-archiving.
// Everything else stays a link-out (see MISSING.md) — no paywall or bot-check circumvention.
//
// Every download is verified: must be a real PDF and page 1 must contain the paper's title words.
//   node tools/fetch_pdfs.mjs [--dry-run] [--only SLUG] [--no-verify]
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entries = JSON.parse(readFileSync(join(root, "data", "cv_entries.json"), "utf8"));
const oa = JSON.parse(readFileSync(join(root, "data", "oa.json"), "utf8"));
const manifestPath = join(root, "data", "pdf_manifest.json");
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};
const dry = process.argv.includes("--dry-run");
const noVerify = process.argv.includes("--no-verify");
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
const UA = "junaidqadir-publications-archive/1.0 (+https://github.com/junaidqadir/publications)";
const MAX_BYTES = 80 * 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pdfjs = null;
if (!noVerify) {
  try {
    pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  } catch {
    console.warn("pdfjs-dist not installed (npm i -D pdfjs-dist): downloads will be marked 'unverified'");
  }
}

const norm = (t) => (t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
async function firstPageText(buf) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true, verbosity: 0 }).promise;
  const page = await doc.getPage(1);
  const tc = await page.getTextContent();
  return tc.items.map((i) => i.str).join(" ");
}
async function titleMatches(buf, title) {
  const text = norm(await firstPageText(buf));
  const words = [...new Set(norm(title).split(" ").filter((w) => w.length > 3))];
  if (!words.length) return null;
  const hit = words.filter((w) => text.includes(w)).length;
  return hit / words.length;
}

let ok = 0, skipped = 0, failed = 0;
const errPath = join(root, "data", "fetch_errors.json");
const errors = existsSync(errPath) ? JSON.parse(readFileSync(errPath, "utf8")) : {};
for (const e of entries) {
  if (only && e.slug !== only) continue;
  const r = oa[e.slug];
  if (!r?.best?.url || r.status !== "hostable") continue;
  const rel = `pdf/${e.year ?? "undated"}/${e.slug}.pdf`;
  const abs = join(root, rel);
  if (existsSync(abs) && manifest[e.slug]) { skipped++; continue; }
  if (dry) { console.log(`would fetch ${e.cv_label}  ${r.best.url}`); continue; }

  try {
    const res = await fetch(r.best.url, { headers: { "User-Agent": UA, Accept: "application/pdf" }, redirect: "follow", signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error(`too large (${(buf.length / 1e6).toFixed(0)} MB)`);
    if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new Error("not a PDF (landing page or login wall)");
    let verified = "unverified", score = null;
    if (pdfjs) {
      try {
        score = await titleMatches(buf, e.title);
        if (score !== null && score < 0.6) throw new Error(`page-1 text does not match the title (${Math.round(score * 100)}%) — wrong paper?`);
        verified = score === null ? "unverified" : "title";
      } catch (err) {
        if (/does not match/.test(err.message)) throw err;
        verified = "unreadable"; // scanned/odd PDFs: keep, but flag
      }
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, buf);
    manifest[e.slug] = {
      path: rel,
      bytes: buf.length,
      sha256: createHash("sha256").update(buf).digest("hex"),
      source: r.best.source,
      url: r.best.url,
      landing: r.best.landing || null,
      version: r.best.version || "unknown",
      license: r.best.license || null,
      verified,
      title_match: score === null ? null : Number(score.toFixed(2)),
      fetched_at: new Date().toISOString().slice(0, 10),
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    delete errors[e.slug];
    ok++;
    console.log(`✓ ${e.cv_label.padEnd(5)} ${rel}  (${(buf.length / 1e6).toFixed(1)} MB, ${verified})`);
  } catch (err) {
    failed++;
    console.log(`✗ ${e.cv_label.padEnd(5)} ${e.slug}: ${err.message}`);
    errors[e.slug] = { message: err.message, url: r.best.url, at: new Date().toISOString().slice(0, 10) };
  }
  await sleep(/arxiv/.test(r.best.url) ? 3200 : 800);
}
writeFileSync(errPath, JSON.stringify(errors, null, 2) + "\n"); // never rewrite oa.json: find_oa.mjs owns it
console.log(`\nDone: ${ok} downloaded, ${skipped} already present, ${failed} failed.`);
