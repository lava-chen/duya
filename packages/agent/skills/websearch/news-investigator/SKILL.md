---
name: news-investigator
description: "Deep investigative news and event research skill. Use when the user wants to research a news event, breaking story, or real-world development — understand the full timeline, verify credibility, find primary sources, or get multi-perspective coverage. Trigger for queries about current events, fact-checking, situation research, or distinguishing reliable from unreliable information."
compatibility:
  tools:
    - browser (required — parallel execution strongly preferred)
  parallel_browsers: recommended (3–6 simultaneous sessions)
---

# News Investigator

A structured skill for deep, multi-source, credibility-aware investigation of news events and real-world situations. Designed for agents with browser tools, with strong preference for parallel execution.

---

## Quick Reference

```
Phase 0  →  Event Profiling          (internal reasoning, ~2 min)
Phase 1  →  Parallel Sweep           (browser parallel, ~5–10 min)
Phase 2  →  Deep Dive & Verification (targeted follow-up, ~5 min)
Phase 3  →  Synthesis & Output       (structured report)
```

Read `references/platforms.md` for platform-specific search strategies.  
Read `references/credibility.md` for the full credibility scoring system.  
Read `references/search-syntax.md` for advanced search operator reference.  
Use `scripts/timeline_builder.py` to structure and deduplicate timeline events.

---

## Phase 0: Event Profiling

Before any browser action, do this internal reasoning pass. Output a structured profile:

```
EVENT_PROFILE:
  canonical_name:    [standard name in English + original language if different]
  origin_region:     [country/region where event originates]
  primary_languages: [ordered list — start with origin language, not just English]
  event_type:        [one of: political / disaster / conflict / technology /
                      financial / social / health / legal / science]
  known_actors:      [key people, organizations, governments involved]
  timeline_anchor:   [earliest known date/time — use "unknown" if unclear]
  controversy_level: [low / medium / high — affects how aggressively to seek
                      counter-sources]
  parallel_strategy: [how to split into parallel browser tasks — see below]
```

**Language priority rule**: Always search in the origin language first. A flood in Brazil yields richer early information in Portuguese than English. A corporate scandal in Japan surfaces first in Japanese financial press. Never assume English-language results are complete.

**Parallel strategy planning**: Decide upfront how to split Phase 1 into parallel tracks. Aim for 3–6 tracks with zero overlap. Typical split:
- Track A: Origin-language mainstream media
- Track B: English-language international press  
- Track C: Social platforms (X, Reddit, Telegram)
- Track D: Official sources (government, institutions)
- Track E: Local/regional small media
- Track F: Historical/archival (early reports, pre-event context)

---

## Phase 1: Parallel Information Sweep

**Run all tracks simultaneously. Do not wait for one track to finish before starting another.**

### Track A — Origin Language Mainstream
Search the event in its native language on regional search engines (Baidu for China, Yandex for Russia/CIS, Naver for Korea, etc.). Target established local news outlets. Collect:
- First reports with timestamps
- Quotes from named sources
- Any official statements released locally before international pickup

### Track B — International Press
Target wire services first (Reuters, AP, AFP) as credibility baseline. Then BBC, major national newspapers. Note: wire service reports are often the source that all others cite — identifying the wire report helps detect citation loops downstream.

### Track C — Social Platforms
See `references/platforms.md` → Social Media section for platform-specific strategies. Key principle: **social media is for leads and timeline signals, not conclusions.** Collect:
- Earliest timestamped posts about the event
- Eyewitness accounts (geotagged or named)
- Official account statements
- High-engagement threads that surface disputed claims

### Track D — Official & Institutional Sources
Government press releases, regulatory filings, court documents, NGO reports, international organization statements (UN, WHO, etc.). These are slow but often the only unambiguous primary source. Use direct URL access when known — don't rely on search to surface them.

### Track E — Local & Niche Media
Small regional outlets, trade press, community news sites. These often publish before major outlets and without the editorial distance that strips out specific details. Search `site:` operators targeting regional TLDs (`.br`, `.kr`, `.de`) or use DuckDuckGo which surfaces smaller sites better than Google.

### Track F — Archive & Historical
Search Wayback Machine for cached versions of pages that may have been edited. Search for the event name with early date ranges to find first mentions. Look for pre-event context: was this situation building up? Were warnings published?

---

## Phase 2: Deep Dive & Verification

After the parallel sweep, you will have a pool of raw information. Now do targeted follow-up:

### Citation Loop Detection
Pick the 3 most-repeated claims. For each:
1. Find the article making the claim
2. Check if it cites a source
3. Find that source — does it actually say what the article claims?
4. Repeat until you reach an uncited primary source or confirm a citation loop

**Citation loops are common**: Source A cites Source B, Source B cites Source C, Source C cites Source A. This means there is effectively one source (or none). Flag these explicitly in output.

### Reverse Search for Disputed Claims
For any claim marked "disputed" or from a low-credibility source:
- Search: `"{claim}" debunked` or `"{claim}" false` or `"{claim}" correction`
- Search for the claim in the origin language separately
- Check fact-checking organizations: Snopes, PolitiFact, AFP Fact Check, Full Fact, regional equivalents

### Version History Check
For key articles or official statements:
- Check Wayback Machine for the URL to see if content was silently edited
- Compare current version with cached version
- Note any material changes — silent corrections are themselves newsworthy

### Actor Background Verification
For named sources or key actors:
- Verify their stated identity/role via LinkedIn, institutional pages, prior reporting
- Search their prior statements on this topic for consistency
- Note any conflicts of interest, affiliations, or prior credibility issues

---

## Phase 3: Credibility Assessment

For each piece of collected information, apply the tier system. See `references/credibility.md` for full scoring rubric.

**Quick tier guide:**

| Tier | Type | Trust level |
|------|------|-------------|
| T1 | Direct primary: eyewitness account, official doc, raw data | High — verify authenticity |
| T2 | First-hand reporting: journalist at scene, named institutional source | Medium-high |
| T3 | Aggregated reporting: outlet summarizing other outlets | Medium — find original |
| T4 | Social/informal: X posts, forum threads, blog posts | Low — leads only |
| T5 | Anonymous/unknown: no attribution, no verifiable source | Very low — flag prominently |

**Mandatory credibility questions for every claim:**
1. Who benefits from this information being believed? Who loses?
2. Is this source independent of the actors in the story?
3. Has this source been accurate on similar stories in the past?
4. Was this information released proactively or in response to scrutiny?
5. Does the detail level suggest access, or does it feel reconstructed?

---

## Phase 4: Structured Output

Produce the final report in this format:

```markdown
## Event: [Canonical Name]
**Status**: [Ongoing / Resolved / Unclear]  
**Coverage period**: [earliest known date] → [current date]  
**Confidence**: [High / Medium / Low / Fragmented]

---

### Timeline
[Chronological entries — date, event, source tier, source name]
[Mark gaps explicitly: "No verified information for [date range]"]

---

### Established Facts
[Claims with T1/T2 support from ≥2 independent sources]
[Each fact: claim → sources → confidence note]

---

### Disputed / Unverified
[Claims present in coverage but not independently verified]
[Each entry: claim → who asserts it → counter-claims → assessment]

---

### Information Gaps
[What is NOT known that should be]
[Why the gap may exist: too early / suppressed / genuinely unknown]

---

### Source Map
[Key sources used, their tier, and what they contributed]
[Note any citation loops found]

---

### Credibility Notes
[Any systematic bias detected in coverage]
[Platforms or outlets to trust / approach carefully for this story]
[Narrative patterns: who is framing the story in what direction]
```

---

## Core Meta-Instructions

These apply at every phase:

1. **Wide spread is not verification.** A claim repeated 1,000 times with no independent sourcing is still one claim.

2. **Absence is data.** If a major outlet is not covering a story, note it. If a government has not responded, note it. Silence has meaning.

3. **Use parallel browsers aggressively.** Never run searches sequentially that could run simultaneously. Every wait is wasted time.

4. **Match language to origin.** The first question for any search is: what language did this event happen in?

5. **Check what was deleted.** If a page 404s or has been "updated," check Wayback Machine before moving on.

6. **Time-stamp everything.** When you collected information matters as much as the information itself for a developing story.

7. **Report your uncertainty.** A "fragmented" confidence rating with honest gaps is more useful than a false "high confidence" summary.
