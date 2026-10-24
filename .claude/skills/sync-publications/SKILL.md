---
name: sync-publications
description: Re-sync the publications archive with the master CV (QadirCV.tex). Use when the CV gained new papers or details, or when asked to refresh/rebuild the publications index, find open-access PDFs, or update MISSING.md / REVIEW.md.
---

# Sync the publications archive with the CV

The CV (`QadirCV.tex`, kept in Dropbox) is canonical; this repo trails it, never leads it.

1. Back up the CV first (project rule): copy `QadirCV.tex` to `QadirCV_backup_YYYY-MM-DD_HHMM.tex` (Doha time) before any edit to the CV itself.
2. Run `npm run sync -- /path/to/QadirCV.tex`. It parses the CV, discovers open-access copies for entries not yet checked, downloads only what may legitimately be hosted (author preprints, openly licensed publisher copies, whitelisted accepted manuscripts), verifies each PDF's page-1 title, and rebuilds `index.json`, `MISSING.md`, `REVIEW.md`, `README.md`.
3. Read `REVIEW.md` and propose CV fixes to the user (wrong titles, missing DOIs, still-"accepted" entries). Do not edit the CV silently.
4. To host a PDF the user is entitled to share but that was not auto-found: put it at `pdf/<year>/<slug>.pdf` and add `{ "<slug>": { "pdf_url": "...", "version": "...", "note": "..." } }` to `data/overrides.json`. Never commit paywalled PDFs — keep those in `private-archive/` (gitignored).
5. Tags: `tools/build_index.mjs` tags by transparent keyword rules; per-paper corrections go in `data/overrides.json` (`tags`, `themes`, `featured`). Never auto-publish religious/spiritual claims without the user's review.
6. Commit with a message naming what changed (e.g. "Add 3 papers, 2 OA PDFs").
