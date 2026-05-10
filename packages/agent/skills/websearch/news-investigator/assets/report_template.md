# News Investigation Report — Output Template

Copy this template and fill in each section. Remove sections that don't apply.
Sections marked [REQUIRED] must always be present.

---

# Investigation Report: {EVENT_NAME} [REQUIRED]

**Date of report**: {YYYY-MM-DD}  
**Investigation period**: {earliest known date} → {report date}  
**Status**: {Ongoing / Resolved / Unclear}  
**Overall confidence**: {High / Medium / Low / Fragmented}  
**Languages searched**: {list}  
**Parallel tracks used**: {number}

---

## Executive Summary [REQUIRED]

{2–4 sentences. What happened, when, what is confirmed, what is not. Do not editorialize.}

---

## Timeline [REQUIRED]

{Use timeline_builder.py output here, or format manually:}

- **YYYY-MM-DD HH:MM** — {Event description}  
  *{Source} · T{tier} · {confidence badge}*

- **YYYY-MM-DD** — {Event description}  
  *{Source} · T{tier} · {confidence badge}*

> **⚠ Information gap**: {date range} — No verified events found for this period.

{Continue chronologically. Mark gaps explicitly.}

---

## Established Facts [REQUIRED]

Facts supported by ≥2 independent T1/T2 sources with no credible counter-evidence.

1. **{Fact}**  
   Sources: {Source 1 (T1)}, {Source 2 (T2)}

2. **{Fact}**  
   Sources: {Source 1}, {Source 2}

{If no facts meet this threshold, state: "No claims currently meet the established threshold. See Probable section."}

---

## Probable Claims

Single T1/T2 source + corroborating signals, or multiple T2/T3 sources.

- **{Claim}** — Source: {Source (tier)}. Supporting signals: {what corroborates}.  
  *What would establish this: {what additional verification would upgrade it}*

---

## Disputed / Contested Claims

Claims where sources directly contradict each other.

### {Claim in dispute}

| Position | Claim | Source | Tier | Notes |
|----------|-------|--------|------|-------|
| {Side A} | {What they say} | {Source} | T{n} | |
| {Side B} | {What they say} | {Source} | T{n} | |

*Assessment: {Brief note on which position has stronger evidential backing, if determinable}*

---

## Unverified Claims

Claims circulating in T3–T5 sources without independent verification.

- **{Claim}** — Circulating on: {platforms}. Not independently verified. Status: monitoring.

---

## Information Gaps [REQUIRED]

What is NOT known that should be, and why the gap may exist.

| Gap | Why it matters | Likely reason for gap |
|-----|---------------|----------------------|
| {What is unknown} | {Why this matters for understanding the story} | {Too early / Access restricted / Deliberate suppression / Genuinely unknown} |

---

## Source Map [REQUIRED]

Key sources used in this investigation and their contributions.

| Source | Tier | Contributed | Notes |
|--------|------|-------------|-------|
| {Reuters} | T2 | {First wire report, timeline anchor} | |
| {Local outlet X} | T2 | {Ground-level detail, eyewitness accounts} | |
| {X/Twitter: @account} | T4 | {Early signal, led to Reuters investigation} | Not cited as evidence |
| {Official statement, Ministry Y} | T1 | {Government position, denial of claim Z} | Self-serving; compared against T2 |

### Citation Loops Detected

{If none: "No citation loops detected in key claims."}

{If found: "**LOOP**: The claim that {X} traces to a single origin — {outlet/source}, published {date}. 
Subsequent reporting by {outlet list} all derive from this source despite appearing independent."}

---

## Credibility & Bias Notes

### Systematic patterns observed
{Note any observable slant in how the story is being covered across source clusters.}

### Sources to treat with caution for this story
{Any outlet or source type that showed bias, inaccuracy, or conflicts of interest specific to this event.}

### Recommended primary sources for follow-up
{Where to look for continuing developments.}

---

## Confidence Assessment [REQUIRED]

| Dimension | Assessment | Rationale |
|-----------|-----------|-----------|
| Factual completeness | {High / Medium / Low} | {How much of what happened is verified} |
| Source independence | {High / Medium / Low} | {Whether sources are genuinely independent} |
| Timeline reliability | {High / Medium / Low} | {How well the chronology is established} |
| Coverage balance | {High / Medium / Low} | {Whether multiple perspectives were accessed} |

**Overall**: {Summary statement about how much confidence to place in this report}

---

## Appendix: Raw Source List

{Full list of all sources consulted, even if not cited in main body}

1. {URL / Document name} — {Date accessed} — {Tier} — {Used for / Discarded because}
2. ...
