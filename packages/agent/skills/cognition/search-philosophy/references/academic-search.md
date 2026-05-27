# Academic & Scientific Search — Reference

Supplementary detail for the `search-philosophy` skill's academic domain.

## Platform Overview

| Platform | Best for | Limitations |
|----------|----------|-------------|
| arXiv | CS, physics, math, quantitative biology — preprints | No peer review; quality varies widely |
| Google Scholar | Broad coverage, citation graph | Poor filtering; mixes preprints/publications |
| Semantic Scholar | AI-powered relevance, citation graph, abstracts | Coverage thinner outside CS/biomed |
| Scopus / Web of Science | Rigorous journal filtering | Paywalled; misses preprints |
| PubMed | Biomedical sciences | Domain-specific |
| IEEE Xplore | Engineering, EE, signal processing | Paywalled full text |

## arXiv Search Strategy

arXiv's built-in search is weak. Prefer:
- `arxiv.org/search/` with category filter (e.g., `cs.LG`, `physics.ao-ph`)
- Google: `site:arxiv.org [query]`
- Semantic Scholar with arXiv filter enabled

**Reading an arXiv paper efficiently:**
1. Abstract: is this the right topic?
2. Introduction, last 2–3 paragraphs: what gap does it claim to fill?
3. Figure 1 / main results table: what did they actually find?
4. Conclusion / Limitations: what do they admit doesn't work?
5. References: who are the 5–10 most cited? Those are the field's anchors.

## Finding Survey Papers

Survey papers (also called "review papers" or "systematic reviews") save enormous time by summarizing a subfield.

Query patterns:
- `[topic] survey 2023`
- `[topic] review deep learning`
- `[topic] overview recent advances`
- In Google Scholar: `[topic]` → filter by review articles

A good survey paper's reference list is often worth more than the survey itself — it is a curated index of the field's primary literature.

## Citation Graph Navigation

**Forward citations** (who built on this work):
- Google Scholar: click "Cited by N" under any result
- Semantic Scholar: "Citations" tab
- Connected Papers (`connectedpapers.com`): visual graph

**Backward citations** (what this work builds on):
- Read the introduction's "Related Work" section
- The references section lists all cited works
- Prioritize papers cited by *multiple* papers you've found — they are the field's foundations

## Identifying Key Venues

Every subfield has 2–5 top publication venues. Knowing them lets you search systematically.

How to find them:
1. Look at where the highly-cited papers in your survey are published
2. Ask: "What conference / journal does [author name] publish in?"
3. Check `csrankings.org` for CS venue rankings by subfield

Once identified, you can search: `site:proceedings.neurips.cc [topic]` or `"ICML 2024" [topic]`

## Checking Author Credibility

For a paper you're unsure about:
1. Find the corresponding author on Google Scholar or institutional page
2. Check h-index and citation count (not absolute measures, but signals)
3. Check if they've published in top venues before
4. Check if their institution has a relevant lab/group

For domain experts (not necessarily paper authors):
- Who is quoted in major news pieces on this topic?
- Who keynotes at the relevant conferences?
- Who maintains the widely-used open-source implementations?

## Preprint vs. Published — What Changes

Preprints on arXiv may differ substantially from published versions:
- Results may be strengthened or weakened after review
- Scope may be narrowed
- Errors may be corrected

When precision matters, always check if a preprint has been published and use the published version. Check: Google Scholar listing, or search for paper title + journal name.

## Handling Paywalled Papers

In order of preference:
1. Check if arXiv preprint exists (usually does for CS/physics)
2. Check author's personal/institutional page (many post PDFs legally)
3. Semantic Scholar often has full-text PDFs via open access agreements
4. Email corresponding author directly (response rate is surprisingly high)
5. Unpaywall browser extension finds legal open-access versions