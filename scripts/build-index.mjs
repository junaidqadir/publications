import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const papersDir = join(__dirname, "..", "papers");
const importedFile = join(__dirname, "..", "imported", "cv-bibliography.json");
const outFile = join(__dirname, "..", "index.json");

function normTitle(t) {
  return (t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

const files = readdirSync(papersDir).filter(
  (f) => f.endsWith(".yaml") && !f.startsWith("_")
);

// Hand-curated entries (papers/*.yaml) - small set, full editorial detail
// (abstracts, verified bibtex, etc). These always win over the bulk import
// below when the same paper appears in both.
const curated = files.map((file) => {
  const raw = readFileSync(join(papersDir, file), "utf8");
  const data = yaml.load(raw);
  if (data.slug !== file.replace(/\.yaml$/, "")) {
    throw new Error(`slug mismatch in ${file}: slug field is "${data.slug}"`);
  }
  return data;
});
const curatedTitles = new Set(curated.map((p) => normTitle(p.title)));

// Bulk-imported corpus, regenerated from the CV via
// archive-local/enrich-bibliography.mjs - not hand-edited, so any paper
// already covered by a curated YAML file above is skipped here.
let imported = [];
if (existsSync(importedFile)) {
  imported = JSON.parse(readFileSync(importedFile, "utf8")).filter(
    (p) => !curatedTitles.has(normTitle(p.title))
  );
}

const papers = [...curated, ...imported];
papers.sort((a, b) => (b.year ?? 0) - (a.year ?? 0));

writeFileSync(outFile, JSON.stringify(papers, null, 2) + "\n");
console.log(`Wrote ${papers.length} entries to index.json (${curated.length} curated + ${imported.length} imported)`);
