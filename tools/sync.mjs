#!/usr/bin/env node
// One-command re-sync after editing the CV:   npm run sync -- /path/to/QadirCV.tex
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cv = process.argv[2] || process.env.CV_TEX;
if (!cv) { console.error("usage: npm run sync -- /path/to/QadirCV.tex"); process.exit(1); }
const steps = [
  ["parse_cv.mjs", [cv]],
  ["find_oa.mjs", []],     // only looks up entries not yet checked; use --refresh to redo all
  ["fetch_pdfs.mjs", []],  // only downloads what is hostable and not already archived
  ["build_index.mjs", []],
];
for (const [file, args] of steps) {
  console.log(`\n── ${file} ──`);
  const r = spawnSync("node", [join(here, file), ...args], { stdio: "inherit" });
  if (r.status !== 0) { console.error(`${file} failed`); process.exit(r.status ?? 1); }
}
console.log("\nSynced. Review MISSING.md and REVIEW.md, then commit.");
