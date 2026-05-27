---
name: search-philosophy
description: A systematic methodology for finding high-quality, authoritative information on the internet. Use this skill whenever a task requires non-trivial web research — including competitive analysis, technical investigations, literature discovery, data sourcing, fact verification, or any situation where the first page of Google results is likely insufficient. Trigger on phrases like "research X", "find information about", "look into", "investigate", "what's the current state of", "find evidence for", or whenever a multi-step search strategy would produce meaningfully better results than a single query. Also trigger when the user seems frustrated with search quality or asks how to find something they can't locate.
allowed-tools: [web_search, browser, web_extract]
---

# Search Philosophy

Effective internet research is not about searching more — it is about searching *smarter*. Most agents fail at research because they issue one or two obvious queries, accept whatever surfaces, and move on. This skill encodes a structured methodology for finding information that is accurate, authoritative, and actually relevant.

## Core Principle: The Funnel Model

Every research task follows the same shape: **wide → narrow → verify**.

1. **Wide**: Establish the landscape. Who talks about this? What vocabulary do they use?
2. **Narrow**: Target the authoritative sources within that landscape.
3. **Verify**: Cross-check key claims across independent sources.

Never collapse these stages. Jumping straight to narrow queries when you don't yet know the vocabulary of a field produces confident-sounding but unreliable results.

---

## Phase 1: Query Construction

### Start with vocabulary discovery, not answers

Before searching for the thing itself, search for *how people talk about the thing*. Different communities use different terms for the same concept. The term you started with may not be the term the authoritative sources use.

**Example**: Searching "AI weather forecasting" vs. "NWP neural parameterization" vs. "ML-based ensemble post-processing" will return almost completely non-overlapping result sets, all legitimately relevant to the same domain.

**Tactic**: In the first 1–2 queries, look for survey articles, Wikipedia entries, or overview pieces. These reveal the canonical vocabulary, key sub-topics, and major actors in the space.

### Query construction rules

| Rule | Rationale |
|------|-----------|
| 2–4 words for initial queries | Short queries cast a wider net; you can always narrow |
| Use the domain's own terminology | Don't impose lay terms onto technical fields |
| Vary synonyms across queries | "neural network" / "deep learning" / "ML model" often return different results |
| Use year qualifiers for fast-moving topics | "LLM reasoning 2024" vs. "LLM reasoning" dramatically changes recency |
| Avoid questions as queries | "what is X" retrieves definition pages; "X mechanism overview" retrieves technical content |

### Advanced operators (use deliberately, not by default)

- `site:domain.com` — constrain to a specific source you already trust
- `filetype:pdf` — find reports, papers, official documents
- `"exact phrase"` — only when you know the canonical name of a specific thing
- `after:YYYY-MM-DD` — filter by publication date when recency is critical
- `-term` — exclude noise terms when a keyword is heavily polluted

**Warning**: Don't reach for operators on the first query. They narrow too aggressively before you know what you're looking for.

---

## Phase 2: Source Evaluation

### The Credibility Hierarchy

Not all sources are equal. Mentally rank sources before trusting their claims:

**Tier 1 — Primary / Original**
- Peer-reviewed papers (check journal reputation, not just presence)
- Official government / regulatory documents
- Company SEC filings, earnings calls, official press releases
- Dataset providers publishing their own methodology

**Tier 2 — Authoritative Secondary**
- Established trade publications with named authors and editorial standards
- Well-maintained GitHub repositories from recognized organizations
- Documentation from the software/system itself
- Preprints on arXiv (treat as strong signal, not verified fact)

**Tier 3 — Aggregated / Derivative**
- News articles citing primary sources (read the primary, not the article)
- Blog posts from domain practitioners (valuable for opinion, not for facts)
- Reddit/HN/forum discussions (valuable for discovering sources and vocabulary)
- Wikipedia (excellent entry point, unreliable endpoint)

**Tier 4 — Noise**
- SEO-optimized listicles
- Content farms
- Social media threads without citations
- AI-generated summaries of other summaries

**Key rule**: If a claim matters, trace it to Tier 1 or Tier 2. Never let a Tier 3–4 source be the final word on a factual claim.

### Red flags for low-quality sources

- Claims without citations or links to evidence
- Author has no verifiable identity or relevant credentials
- Article recycles the same phrases found in many other articles (sign of SEO farming or AI generation)
- Publication date is vague or missing
- Extreme emotional language in what should be a factual piece

### The Citation Reversal Technique

When you find one good source, you can find more by reversing the citation graph:

- **Forward**: Who cites this paper/article? (Google Scholar "Cited by"; Semantic Scholar)
- **Backward**: What does this paper cite? Read the reference list.
- **Lateral**: Who else does this author publish with? What other venues cover this topic?

---

## Phase 3: Information Extraction

### Read selectively, not completely

For most sources, you only need specific sections:
- **Papers**: Abstract → Introduction (last 2 paragraphs) → Results → Conclusion. Read methods only if you need to replicate or critique.
- **News articles**: Lede + last paragraph (usually contains the key facts). The middle is often padding.
- **Documentation**: Search for the specific term rather than reading linearly.

### Capture metadata, not just content

For every source you extract information from, note:
1. Author / organization
2. Publication date
3. Whether the claim is **empirical** (measured), **expert opinion**, or **derived** (computed from other data)

This matters when claims conflict — empirical data from a primary source beats expert opinion, which beats derivative claims.

### When results conflict

Sources will sometimes say different things. Resolution protocol:

1. Check publication dates — one may be outdated
2. Check methodologies — they may be measuring different things with the same label
3. Check who funded/produced each source — interest alignment affects framing
4. If genuinely uncertain after steps 1–3, **report the conflict explicitly** rather than picking one

---

## Phase 4: Verification

### The Three-Source Rule

For any claim that will appear in a final output or inform a significant decision: find **three independent sources** that agree. "Independent" means not derived from each other — three articles all citing the same press release is one source, not three.

### Reverse verification

For counterintuitive or high-stakes claims, actively search for **disconfirming evidence**:
- Query: `"[claim]" criticism` / `"[claim]" debunked` / `"[claim]" limitations`
- Search for who disagrees and why
- If no one disagrees, ask why — consensus is normal in established science; absence of critics in a contested space is suspicious

### Temporal verification

Fast-moving fields can make sources obsolete within months. Before finalizing:
- Note the publication date of your key sources
- For anything older than 12 months in a fast-moving field, search for updates
- Query: `[topic] [current year]` or `[topic] latest`

---

## Domain-Specific Search Strategies

### Academic / Scientific

→ See `references/academic-search.md` for detailed arXiv, Google Scholar, Semantic Scholar workflows.

Start: arXiv abstract search → Google Scholar "Cited by" → check top venues for the subfield → check author pages for recent work.

### Technical / Engineering

- GitHub search (sort by Stars, filter by recently updated)
- Official documentation > Stack Overflow > blog posts
- Check release notes / CHANGELOG for version-specific details
- Hacker News search (`hn.algolia.com`) surfaces practitioner opinions on tools

### Market / Competitive Intelligence

- Crunchbase, PitchBook for funding signals
- LinkedIn for team composition and growth
- App Store / Play Store reviews for user pain points
- G2, Capterra, Trustpilot for structured user feedback
- Job postings reveal strategic priorities ("hiring ML infra engineers" signals a specific roadmap)

### News / Current Events

- Start with outlets known for primary reporting (AP, Reuters, FT, WSJ)
- Cross-reference across ideologically distinct outlets to separate fact from framing
- Check original press releases / official statements when articles seem to be summarizing
- For breaking news: wait for second-wave reporting (24–48h) before trusting specifics

### Statistical / Data Claims

- Trace to the original dataset or report (not the article citing it)
- Check sample size, methodology, date of collection
- Check if the statistic has been updated since initial publication
- WHO, World Bank, OECD, national statistics agencies for macro figures

---

## Common Failure Modes

| Failure | Symptom | Fix |
|---------|---------|-----|
| Query anchoring | First search results shape all subsequent queries | Deliberately use at least 3 different query angles before forming conclusions |
| Recency bias | Always picking the newest source | Check if the newer source actually supersedes or just follows the older one |
| Authority conflation | Trusting a prestigious venue unconditionally | Even top journals publish flawed papers; evaluate the study, not just the journal |
| Confirmation surfacing | Queries implicitly biased toward expected answer | Actively search for "X is wrong" or "problems with X" |
| Surface skimming | Reading headlines and abstracts only | For any critical claim, read the methodology or supporting section |
| Single-language bubble | Searching only in English | Key primary sources in hydrology, materials science, and other fields may be in Chinese, German, or Japanese |

---

## Output Protocol

When presenting research findings:
1. State the confidence level of each key claim (empirical / consensus / disputed / speculative)
2. Cite the tier of the primary source
3. Flag any temporal caveats (source date vs. current date)
4. Explicitly note if a claim could not be verified to Tier 1/2

This makes the research usable and honest, rather than presenting a false uniformity across claims of different quality.