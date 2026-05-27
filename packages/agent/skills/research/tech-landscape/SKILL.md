---
name: tech-landscape
description: Systematic methodology for mapping the current state of a technology domain — including key players, tools, frameworks, research directions, maturity levels, and adoption trends. Use this skill whenever someone needs to understand the landscape of a technology area rather than just a single tool or paper. Trigger on phrases like "what's the current state of", "landscape of", "overview of tools for", "what are the main approaches to", "survey the field of", "what should I know about X before building", "how mature is", "who are the key players in", or any request to orient in an unfamiliar technical space. Also trigger when someone is making a technology selection, planning a research direction, or trying to understand where the frontier is in a given area.
allowed-tools: [web_search, browser, web_extract]
---

# Tech Landscape Research

Mapping a technology landscape is different from answering a factual question. The goal is to produce a *structured mental model* of a domain: who is doing what, how mature are the approaches, where is the frontier, and what should a practitioner know before diving in.

## Core Principle: Don't Index, Synthesize

A list of tools is not a landscape. A landscape tells you:
- Which approaches are **proven vs. experimental**
- Which players are **shaping the direction** vs. following
- Where the **genuine open problems** are
- What the **practitioner consensus** looks like vs. what researchers are excited about
- What **you should try first** and why

---

## Phase 1: Domain Framing

Before searching, establish the exact scope. Technology landscapes are fractal — you can go arbitrarily deep in any direction. Bounded scope produces a useful map; unbounded scope produces an overwhelming list.

### Scoping questions

Answer these before issuing queries:

1. **What is the core task?** (e.g., "precipitation nowcasting" not just "weather forecasting")
2. **What is the practitioner's intent?** (build a system? choose a library? write a paper? understand competitors?)
3. **What is the relevant scale?** (academic research? production systems? open-source? commercial?)
4. **What time horizon?** (current best practices? bleeding edge? 5-year trajectory?)
5. **What is the existing knowledge level?** (expert in adjacent field? complete newcomer? domain expert needing cross-field view?)

The answers shape which sources to consult and how to structure the output.

---

## Phase 2: Landscape Dimensions

A complete tech landscape covers these dimensions. Not every task requires all of them — identify which matter most for the specific intent.

### 2.1 Taxonomy of Approaches

What are the fundamentally different ways to solve this problem? This is the backbone of the landscape.

- Don't list individual tools yet — identify **approach families** first
- Example for "time series forecasting": statistical (ARIMA, exponential smoothing), ML (gradient boosting on features), deep learning (LSTM, Transformer), hybrid (physics-informed), foundation models (TimeGPT, Lag-Llama)
- Each approach family has different trade-offs, maturity levels, and adoption patterns

### 2.2 Maturity Assessment

For each approach, assess:

| Level | Description | Signals |
|-------|-------------|---------|
| **Research** | Exists in papers, not deployed | Only arxiv/conference papers; no production cases |
| **Early adopter** | Small-scale deployments; high risk | Blog posts from technical teams; GitHub stars growing fast |
| **Growing** | Increasing production use; tooling emerging | Multiple frameworks; cloud provider support; job postings |
| **Mature** | Established best practices; stable APIs | Books exist; certification programs; legacy migration discussions |
| **Declining** | Being superseded; still in use but not chosen for new projects | Stack Overflow questions about migration away; declining GitHub activity |

### 2.3 Key Players

Identify who is driving the field:

**Research institutions**: Which labs publish the foundational papers? (e.g., for ML: DeepMind, OpenAI, Google Brain, FAIR; for hydrology: NCAR, ECMWF, USGS)

**Commercial players**: Which companies are building production systems? What are their differentiation strategies? (Check: their engineering blogs, job postings, conference talks)

**Open-source projects**: Which projects have the most adoption and active maintenance? (Check: GitHub stars + fork count + recent commit activity + issue response time)

**Key individuals**: Who are the researchers or practitioners whose views shape the field? (Check: whose papers get cited most in recent surveys? Who keynotes at the relevant conferences? Who maintains the widely-used implementations?)

### 2.4 Tooling Ecosystem

For each major approach, map the tooling:

| Layer | What to document |
|-------|-----------------|
| **Libraries / frameworks** | Name, language, maturity, typical use case |
| **Pre-trained models** | Available checkpoints, training data, license |
| **Datasets / benchmarks** | Standard benchmarks and leaderboards |
| **Deployment options** | Cloud services, self-hosted options |
| **Evaluation infrastructure** | How do practitioners measure performance? |

### 2.5 Frontier vs. Consensus

This is the most valuable dimension and the hardest to get right.

**Practitioner consensus**: What does an experienced engineer actually use in production today? Often significantly behind the research frontier. Sources: engineering blogs, conference talks (not research tracks), Stack Overflow, Reddit/HN practitioner discussions.

**Research frontier**: What are researchers publishing that isn't yet in production? Sources: recent top-venue papers, arXiv preprints from leading labs, workshop papers.

**The gap**: How large is the distance between frontier and consensus? In some fields (e.g., web frontend) they're close. In others (e.g., quantum computing) they're enormous. The gap tells you how much of the literature is practically applicable right now.

### 2.6 Open Problems

What are the known unsolved challenges? These signal:
- Where the field is heading next
- What limitations the current best approaches have
- Where there is genuine research opportunity vs. incremental work

Sources: paper "limitations" sections, workshop discussions, practitioner complaints on HN/Reddit, grant proposal summaries.

---

## Phase 3: Research Execution

### Source strategy by dimension

| Dimension | Primary sources |
|-----------|----------------|
| Taxonomy / approaches | Survey papers, Wikipedia, textbook intros |
| Maturity | GitHub activity, production blog posts, job postings |
| Key players (research) | arXiv author affiliations, conference organizing committees |
| Key players (commercial) | Crunchbase, company engineering blogs, LinkedIn |
| Tooling | GitHub, documentation sites, Papers With Code |
| Frontier | arXiv (last 6 months), top venue proceedings (last 1–2 years) |
| Consensus | HN, Reddit subforums, Stack Overflow, practitioner conference talks |
| Open problems | Workshop papers, grant databases (NSF, NIH, ERC), Twitter/X threads from researchers |

### Query patterns

```
[domain] survey 2024
[domain] state of the art
[domain] open problems challenges
[domain] production deployment [company blog]
[domain] tools comparison
[tool name] vs [tool name]
[domain] job requirements [LinkedIn / job boards]
site:news.ycombinator.com [domain]
```

### GitHub signals

When evaluating a tool or library:
- **Stars**: crude popularity signal, easily gamed — weight less
- **Forks**: more meaningful for research code
- **Recent commits**: Is it actively maintained?
- **Issue response time**: Does the maintainer engage with users?
- **PR merge rate**: Is external contribution welcomed?
- **Used by count**: How many public repos depend on it?
- **Contributors**: One-person project vs. community project?

### Trend signals

Beyond static snapshots, look for directional signals:

- **Stack Overflow survey**: Tracks language/framework adoption year-over-year
- **GitHub Star History** (`star-history.com`): Plot star growth over time — exponential growth signals emerging momentum
- **Google Trends**: Search interest over time
- **Job posting trends**: `LinkedIn`, `levels.fyi`, Indeed — what skills are being hired for?
- **Conference program trends**: Are certain topics growing/shrinking as paper categories?

---

## Phase 4: Synthesis

### The Landscape Map Structure

Organize findings into a structured output. The exact format depends on the user's intent, but this structure works for most cases:

```
## [Domain] Landscape — [Date]

### TL;DR for Practitioners
[3–5 sentences: what should someone building in this space know immediately?]

### Approach Families
[For each major approach]:
  - What it is
  - When to use it
  - Maturity level
  - Representative tools

### Who's Shaping the Field
[Research leaders, commercial players, key OSS projects]

### Current Frontier
[What the latest research is focused on — separate from what's in production]

### Practitioner Consensus
[What experienced builders actually use and why]

### Key Open Problems
[Known limitations that haven't been solved]

### Recommended Starting Point
[Given the user's stated intent, what should they read/try first?]
```

### Calibrating confidence

Be explicit about what you know vs. what you've inferred:

- **High confidence**: Established tools, papers from top venues, data from authoritative sources
- **Medium confidence**: Practitioner reports, recent preprints, fast-moving areas
- **Low confidence**: Emerging tools (<6 months old), anecdotal reports, heavily contested claims

Tag claims accordingly. A landscape that presents everything with equal confidence is misleading.

### Avoiding common failure modes

| Failure | Description | Prevention |
|---------|-------------|------------|
| **Tool list masquerading as landscape** | Lists 20 tools with no synthesis | Force yourself to write what makes each approach *different* |
| **Recency bias** | Only covering latest papers/tools | Check what's in production, not just what's published |
| **Incumbency bias** | Defaulting to the popular tools without questioning maturity | Explicitly check "what are the alternatives and why aren't they dominant?" |
| **English-language bias** | Missing significant work from non-English-language communities | For domains with strong Chinese/European research communities, search natively |
| **Static snapshot** | Capturing current state without signaling trajectory | Always add "where is this heading?" to the analysis |

---

## Output Delivery

Tailor the output format to the user's intent:

| Intent | Appropriate output |
|--------|-------------------|
| "I need to choose a tool" | Comparison table + recommendation with reasoning |
| "I'm writing a related work section" | Narrative taxonomy with key citations |
| "I'm exploring a new field" | Structured overview with recommended reading list |
| "I'm doing competitive analysis" | Player map + differentiation matrix |
| "I'm writing a grant / proposal" | Frontier + open problems emphasis |

Never produce a landscape map and leave the user to figure out what to do with it. End with a concrete "**given your situation, here's what I'd recommend as the first step**" statement.