# Credibility Assessment System

Full reference for evaluating source quality and claim reliability.

## Table of Contents
1. [Source Tier System](#tier-system)
2. [Claim Confidence Scoring](#confidence-scoring)
3. [Bias Detection Framework](#bias-detection)
4. [Citation Loop Detection](#citation-loops)
5. [Red Flags Checklist](#red-flags)
6. [Outlet Track Record Notes](#outlet-track-record)

---

## 1. Source Tier System {#tier-system}

### T1 — Primary Source
**Definition**: The event or claim in its unmediated form.

Examples:
- Court documents, filings, official transcripts
- Raw sensor/satellite data from authoritative body
- Direct eyewitness account with verifiable identity and location
- Official government or institutional press releases (as T1 *statements*, though content may be self-serving)
- Video/audio recorded at the scene with verifiable metadata
- Company SEC filings or regulatory disclosures

**Assessment questions:**
- Can the authenticity of the document/recording be verified?
- Is the eyewitness identity and location consistent with the claimed event?
- For official statements: who issued it, under what authority, and with what accountability?

**Important caveat**: T1 does not mean *true*. Official documents can be false. Eyewitnesses can be mistaken. T1 means *closest to the event* — it still requires coherence checking against other T1/T2 sources.

---

### T2 — First-Hand Reporting
**Definition**: A journalist or researcher who directly interviewed sources, accessed documents, or was present.

Examples:
- Newspaper bylined report with named sources
- Wire service report from journalist in the location
- Academic paper with disclosed methodology
- NGO field report with identified researchers

**Assessment questions:**
- Does the reporter name their sources, or are they all "anonymous officials"?
- Is the outlet's editorial process transparent?
- Does the reporter have a track record on this beat?
- Is this the outlet's own reporting, or did they interview someone else's reporter?

---

### T3 — Aggregated / Secondary Reporting
**Definition**: Reporting that synthesizes or summarizes other reporting without original access.

Examples:
- "According to Reuters, ..." articles that add no original reporting
- News roundups, summaries
- Analysis pieces drawing on existing coverage

**Use**: Useful for finding what the T1/T2 sources said; always go back to the T1/T2 source directly.

**Risk**: Aggregated reporting introduces compression errors — details get dropped, context is lost, and sometimes meaning is subtly altered.

---

### T4 — Informal / Social
**Definition**: User-generated content without editorial accountability.

Examples:
- X/Twitter posts (except verified institutional accounts)
- Reddit threads
- Telegram messages
- Forum posts, comment sections
- Blog posts without verifiable author identity

**Use**: High value for *leads* and *timeline signals*. Low value as standalone evidence.

**Upgrade path**: A T4 source that contains a verifiable artifact (identifiable photo, document excerpt, video with metadata) can partially support a claim if the artifact checks out — but cite the artifact, not the social post.

---

### T5 — Unknown / Unverifiable
**Definition**: No clear author, no traceable origin, no way to assess reliability.

Examples:
- Anonymous website with no "About" page and recent domain registration
- Screenshots of unknown origin
- Forwarded messages with no traceable source
- AI-generated summaries presented as news

**Use**: Flag and set aside unless you can upgrade by tracing the origin. Never cite as supporting evidence.

---

## 2. Claim Confidence Scoring {#confidence-scoring}

After assessing sources, rate each claim's confidence:

### Confidence: Established
**Criteria**: ≥2 independent T1/T2 sources, no credible counter-evidence.
- "Independent" means: neither source derived their information from the other
- Document explicitly which sources constitute independence

### Confidence: Probable
**Criteria**: 1 T1/T2 source + corroborating T3/T4 signals, no strong counter-evidence.
- Note what would upgrade this to Established

### Confidence: Contested
**Criteria**: T1/T2 sources exist but directly contradict each other, OR significant expert disagreement.
- Document each side's claim and sourcing
- Note what would resolve the dispute

### Confidence: Unverified
**Criteria**: Only T3–T5 sources, or single T2 source without corroboration.
- Note: this is not the same as "false" — it means the claim needs more verification

### Confidence: Disputed / Likely False
**Criteria**: Credible counter-evidence from T1/T2 sources contradicts the claim, or the claim has been formally corrected/retracted.
- Note the counter-evidence explicitly

---

## 3. Bias Detection Framework {#bias-detection}

All sources have perspective. The goal is not to find "unbiased" sources (they don't exist) but to understand and account for each source's systematic tendencies.

### Structural Biases

**Institutional bias**: Sources tied to institutions report favorably on those institutions. Government sources frame government actions positively. Corporate PR frames corporate actions positively. Factor this in — the *facts* may be accurate but the *framing* is systematically selected.

**Geographic bias**: International outlets covering foreign events often lack local context, miss language-specific nuance, and may apply home-country interpretive frameworks inappropriately. A US outlet covering an East Asian political crisis may get facts right but framing wrong.

**Commercial bias**: Outlets dependent on advertising may soften coverage of major advertisers. Subscription-based outlets have incentives to produce content their subscriber base finds confirming. Both distort in different directions.

**Recency bias**: "What just happened" coverage is fast but often shallow. The real context often emerges in second-day reporting or longer-form analysis.

### Active Bias Detection

For any story where bias could be significant, ask:
1. **Who is prominently quoted?** Whose voice is centered vs. mentioned in passing?
2. **Who is absent?** Whose perspective is not represented at all?
3. **What is assumed to be obvious?** Framing often hides in what the article doesn't explain because it "goes without saying."
4. **What is the emotional register?** Does the language editorialize while appearing factual?
5. **What comparisons are drawn?** Historical analogies and comparisons carry implicit arguments.

### Comparing Cross-Source Framing

For high-controversy topics, deliberately source from:
- Origin-country press (may have access but also interest)
- Opposing-party press (may overcorrect but surfaces what pro- sources omit)
- Neutral third-country press (often the least emotionally invested)
- Specialty press (trade outlets, academic commentators)

Note framing differences without necessarily "averaging" them — the disagreement itself is part of the story.

---

## 4. Citation Loop Detection {#citation-loops}

Citation loops are one of the most common forms of apparent-but-false corroboration in digital news.

### How loops form

1. Outlet A reports a claim, citing an "anonymous source"
2. Outlet B reports "Outlet A says X" — now there are two mentions
3. Outlet C reports "Multiple outlets are saying X" — looks like broad consensus
4. Outlet A updates their piece to note "widespread reporting confirms X"

Result: The appearance of multiple independent sources, but there is actually only one original claim.

### Detection procedure

For any claim that appears in 3+ sources:
1. Find the earliest publication (use date-restricted search and Wayback Machine)
2. Check each subsequent article: does it cite the prior one?
3. Trace the citation chain back to the original
4. Assess the original: is it T1/T2 with named sources, or T3/T4?

### Loop variants to watch for

**The laundering loop**: A low-credibility site publishes a claim → a mid-tier outlet cites it without attribution as "reports say" → a major outlet cites the mid-tier outlet.

**The expert circuit**: One expert makes a claim in one article → other articles cite that expert, giving impression of expert consensus, but all citations trace to one quote in one interview.

**The translation chain**: Claim originates in language A → translated/summarized in language B → cited in language C → accuracy degrades at each step but citation chain looks solid.

**How to flag**: In output, mark as `[CITATION LOOP DETECTED — traces to single origin: [source]]`

---

## 5. Red Flags Checklist {#red-flags}

Immediately flag for deeper scrutiny when you encounter:

**Domain red flags:**
- [ ] Domain registered recently (< 1 year) for a "news" site
- [ ] No "About Us" page or vague/uninformative one
- [ ] Design mimics a known outlet (name, logo, URL similar)
- [ ] Claims to be local outlet but no local staff or address

**Content red flags:**
- [ ] No byline, or byline is a generic name with no searchable history
- [ ] Claims are extremely specific but have no named sources
- [ ] All articles share one political narrative direction
- [ ] Images don't match the story (reverse image check)
- [ ] Timestamps inconsistent (article claims to be from date X but content references later events)

**Propagation red flags:**
- [ ] Story is aggressively being pushed by accounts with similar creation dates
- [ ] High engagement but very few critical comments
- [ ] Story only appears on sites of one ideological cluster
- [ ] No coverage in origin-language press for a story claimed to originate there

**Quote red flags:**
- [ ] Quote is suspiciously perfect — exactly what you'd expect the person to say
- [ ] Quote cannot be found in the original interview/statement
- [ ] Quote is slightly different across different citing articles (indicates no one has the original)
- [ ] Speaker later denied or clarified the quote

---

## 6. Outlet Track Record Notes {#outlet-track-record}

General principles (specific outlet assessments change over time — always cross-check):

**Wire services (Reuters, AP, AFP)**: High baseline reliability on factual claims. Not immune to errors, particularly in fast-moving breaking news. First reports frequently require correction. Strong on "what happened," weaker on "why."

**State media (Xinhua, TASS, RT, etc.)**: Factually accurate on uncontroversial domestic matters. Systematically unreliable on stories touching state interests. Useful as a source for what the state *is saying*, not what *is true*. Never cite alone; use to identify official position for comparison.

**Tabloid press**: Some tabloids (NY Post, Daily Mail) break legitimate stories that other outlets miss due to their willingness to publish without full verification. Others are predominantly fabricated. Check outlet history on specific topic areas.

**Hyperpartisan outlets**: Often contain real facts embedded in misleading framing. Useful for understanding what a partisan community believes; never reliable for factual baseline.

**Specialist/trade press**: Often the highest-quality sourcing for events in their domain. Aviation incident reporting in trade press is often more accurate than general news. Financial press on financial events. Medical press on health events. Prioritize these over general-audience coverage when available.

**Local outlets in non-English countries**: Quality varies enormously but they are often the only source for ground-level detail. When found, try to assess: Does this outlet have a physical address? Staff names? Years of operation? Funding transparency?
