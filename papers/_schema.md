# Paper entry schema

One YAML file per paper in `papers/`, filename = slug (e.g. `2023-ai-engineering-education.yaml`).

```yaml
slug: 2023-ai-engineering-education      # must match filename (without .yaml)
title: "Full paper title"
authors:
  - "Junaid Qadir"
  - "Co-author Name"
year: 2023
venue: "Journal or Conference name"
doi: "10.xxxx/xxxxx"                     # omit if none yet
oa_url: "https://arxiv.org/abs/xxxx"     # preferred over pdf — arXiv / OA journal link
pdf: null                                # ONLY set if this is a preprint/AAM you can legally redistribute
bibtex: |
  @article{key2023,
    title={...},
    author={...},
    year={2023}
  }
abstract: "Short abstract, 2-4 sentences."
tags: ["responsible-ai", "education"]
themes: ["ai"]                           # one or more of: ai, education, multiplexity,
                                          # ihsan-ethics, health-psychology, networks-ict4d
featured: true                           # show on personal site's featured list
status: "placeholder"                    # "placeholder" | "final" — placeholder entries
                                          # are schema demos only, not real citations;
                                          # flip to "final" once verified real data is in
```

Themes drive which entries show up where:
- personal site (`junaidqadir-site`) reads all entries, `featured: true` ones on the homepage
- Ihsan Initiative site (`ihsan-initiative-site`) reads only entries tagged `ihsan-ethics` or `multiplexity`

After adding/editing a paper, run `npm run build-index` to regenerate `index.json`.
