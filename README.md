# publications

Structured metadata for Junaid Qadir's publications. Consumed at build time by both
[`junaidqadir-site`](https://github.com/junaidqadir/junaidqadir-site) (personal site)
and [`ihsan-initiative-site`](https://github.com/junaidqadir/ihsan-initiative-site)
(filtered to the `ihsan-ethics` / `multiplexity` themes).

## Scope

This repo holds a **curated subset** of flagship papers, not the full 250+ publication
record. The full record lives on [Google Scholar](https://scholar.google.com/citations?user=EdPPQToAAAAJ&hl=en);
both sites link out to it for the complete list. Entries here are added by hand as they're
curated — see `papers/_schema.md` for the format.

## Copyright note

Do not add a `pdf` path unless the file is a preprint/author's-accepted-manuscript or
otherwise confirmed redistributable — publisher copyright (IEEE, Elsevier, Springer, ACM,
etc.) varies per paper. Default to linking `doi` / `oa_url` (arXiv or the journal's own OA
link) instead of self-hosting the PDF.

## Structure

- `papers/<slug>.yaml` — one file per paper (see `papers/_schema.md`)
- `index.json` — generated list of slugs + themes, read by both sites at build time
  (regenerate with `node scripts/build-index.mjs` after adding/editing a paper)
