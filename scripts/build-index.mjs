import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const papersDir = join(__dirname, "..", "papers");
const outFile = join(__dirname, "..", "index.json");

const files = readdirSync(papersDir).filter(
  (f) => f.endsWith(".yaml") && !f.startsWith("_")
);

const papers = files.map((file) => {
  const raw = readFileSync(join(papersDir, file), "utf8");
  const data = yaml.load(raw);
  if (data.slug !== file.replace(/\.yaml$/, "")) {
    throw new Error(`slug mismatch in ${file}: slug field is "${data.slug}"`);
  }
  return data;
});

papers.sort((a, b) => (b.year ?? 0) - (a.year ?? 0));

writeFileSync(outFile, JSON.stringify(papers, null, 2) + "\n");
console.log(`Wrote ${papers.length} entries to index.json`);
