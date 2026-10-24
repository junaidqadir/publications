# Publications — Junaid Qadir

**101 / 315 PDFs archived.** An organized, regularly synced archive of my publications, derived from my CV.

- [`index.json`](index.json) — every publication with authors, venue, DOI, tags, BibTeX and (where shareable) a PDF path
- [`pdf/`](pdf/) — open-access / author copies, filed by year
- [`MISSING.md`](MISSING.md) — what is not archived, and why
- [`REVIEW.md`](REVIEW.md) — CV entries worth double-checking
- Browse and search on the website: <https://junaidqadir.com/publications> (placeholder domain)

| Type | Entries | With PDF |
|---|---|---|
| journal | 188 | 78 |
| conference | 106 | 22 |
| book-chapter | 8 | 1 |
| misc | 7 | 0 |
| informal | 6 | 0 |

## What is hosted here, and what is not

I host only copies I am entitled to share: **author-posted preprints** (arXiv, SSRN, OSF, TechRxiv, …), **publisher versions under an open (Creative Commons) licence**, and **accepted manuscripts where the publisher's self-archiving policy allows**. Every file records its source, version and licence in `data/pdf_manifest.json`. For closed-access papers this repository links to the publisher (DOI) instead. Copyright in each paper remains with its owner; the version of record is always the DOI.

## How it works

```
QadirCV.tex ─ tools/parse_cv.mjs ─▶ data/cv_entries.json
                tools/find_oa.mjs ─▶ data/oa.json          (arXiv, Semantic Scholar, Crossref, OpenAlex, Europe PMC)
              tools/fetch_pdfs.mjs ─▶ pdf/<year>/<slug>.pdf + data/pdf_manifest.json   (verifies page 1 title)
              tools/build_index.mjs ─▶ index.json, MISSING.md, REVIEW.md, README.md
```

The CV stays canonical: a paper enters the archive only when it is in the CV. Re-sync after editing the CV with `npm run sync -- /path/to/QadirCV.tex`.
