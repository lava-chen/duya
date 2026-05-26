---
name: competitive-intelligence
description: "Systematic competitive intelligence gathering for products and domains. Use when researching competitors, analyzing market positioning, identifying differentiation opportunities, or building product comparison matrices."
allowed-tools: [web_search, browser, web_extract]
---

# Competitive Intelligence

A structured approach to gathering and analyzing competitive information about products, companies, and market segments.

---

## Core Principle

**Competitive intelligence is not copying — it's understanding the playing field to make better decisions.**

Focus on:
- What problems competitors solve (and how well)
- What they explicitly don't do (opportunity gaps)
- How users actually feel (not just marketing claims)
- Where the market is heading (not just where it is)

---

## Phase 1: Define the Intelligence Goals

### Clarify Your Questions

Before searching, know what you're trying to learn:

| Goal Type | Key Questions |
|-----------|---------------|
| Feature comparison | What features does each have? What's missing? |
| Positioning | How do they describe themselves? Who do they target? |
| Pricing strategy | What's the model? What's the actual cost? |
| User sentiment | What do users love/hate? What are common complaints? |
| Market trajectory | Are they growing? Pivoting? Struggling? |
| Technical approach | What stack? What architecture decisions? |

### Define the Competitive Set

**Direct competitors**: Same problem, same approach
**Indirect competitors**: Same problem, different approach
**Adjacent players**: Related problem, potential expansion
**Substitutes**: Different problem, same budget/attention

---

## Phase 2: Multi-Channel Information Gathering

### Channel A: Official Sources

**Product websites**
- Feature pages (what they emphasize)
- Pricing pages (model transparency)
- About/Team pages (company story, funding)
- Documentation (technical depth, API coverage)
- Changelog (velocity, priorities)

**Company communications**
- Blog posts (marketing focus, technical depth)
- Press releases (milestones, partnerships)
- Investor materials (if public)
- Job postings (hiring focus = strategic direction)

### Channel B: User Platforms

**Review aggregators**
- G2, Capterra, TrustRadius (B2B)
- App Store, Play Store (mobile)
- Product Hunt (early adopters)
- G2 Crowd, Capterra (enterprise)

**What to extract:**
- Rating distribution (not just average)
- Recurring themes in reviews
- Feature requests (unmet needs)
- Comparison mentions ("switched from X")

**Community discussions**
- Reddit (r/productname, r/industry)
- Hacker News (search: "Show HN", product mentions)
- Discord/Slack communities
- Stack Overflow tags

### Channel C: Third-Party Analysis

**Industry research**
- Gartner, Forrester reports (if accessible)
- Industry newsletters
- Analyst blogs
- Conference talks/videos

**Media coverage**
- Tech news (TechCrunch, The Information)
- Industry publications
- Podcast interviews with founders
- YouTube reviews/tutorials

### Channel D: Technical Signals

**Public code/infrastructure**
- GitHub repos (open source components)
- Job postings (tech stack hints)
- API documentation (capabilities)
- Security certificates (subdomain enumeration)

**Traffic/engagement**
- SimilarWeb estimates
- Social media follower trends
- GitHub star growth (for OSS)
- Search trend data

---

## Phase 3: Information Synthesis

### Build the Comparison Matrix

Create a structured comparison across key dimensions:

```
Dimension          | Competitor A | Competitor B | Competitor C
-------------------|--------------|--------------|--------------
Core value prop    |              |              |
Target audience    |              |              |
Key features       |              |              |
Missing features   |              |              |
Pricing model      |              |              |
Entry price        |              |              |
Scale price        |              |              |
User sentiment     |              |              |
G2 rating          |              |              |
Founded            |              |              |
Funding stage      |              |              |
Team size          |              |              |
Tech stack         |              |              |
```

### Identify Differentiation Axes

Map competitors on 2-3 key dimensions:

```
                    High Complexity
                          |
    Enterprise B    ●     |     ● Enterprise A
                          |
    ----------------------+----------------------
    SMB B           ●     |     ● SMB A
                          |
                    Low Complexity
                          
    ← Self-serve          Managed →
```

### Find the White Space

Look for:
- Underserved segments ("Everyone targets enterprises, no one helps freelancers")
- Feature gaps ("All lack good mobile experience")
- Pricing gaps ("Nothing between $0 and $500/month")
- Use case gaps ("Great for marketing, terrible for engineering")

---

## Phase 4: Source Credibility Assessment

### Tier the Information

| Tier | Source | Reliability |
|------|--------|-------------|
| T1 | Official docs, verified financials, direct usage | High |
| T2 | Established reviews, reputable media, conference talks | Medium-high |
| T3 | User forums, social media, anonymous reviews | Medium |
| T4 | Rumors, speculation, competitor claims about each other | Low |

### Cross-Verification Rules

- **Claims about competitors**: Verify with 2+ independent sources
- **User complaints**: Check if acknowledged by company (changelog, support)
- **Growth claims**: Look for corroborating signals (hiring, funding)
- **Technical details**: Verify with direct inspection when possible

---

## Phase 5: Structured Output

### Executive Summary Template

```markdown
## Competitive Landscape: [Domain/Product Area]

### Market Map
[2-3 sentence overview of the competitive set]

### Key Players

#### [Competitor A]
- **Positioning**: [one-liner]
- **Strengths**: [2-3 items]
- **Weaknesses**: [2-3 items]
- **Differentiation**: [what makes them unique]
- **Target**: [who they serve best]

#### [Competitor B]
...

### Comparison Matrix
[Table or structured comparison]

### White Space Opportunities
1. [Opportunity 1]: [evidence + reasoning]
2. [Opportunity 2]: [evidence + reasoning]

### Strategic Implications
- [Implication 1]
- [Implication 2]

### Information Gaps
- [What we don't know and how it matters]
```

---

## Platform-Specific Tactics

### Product Hunt
- Check "Ships" tab for product evolution
- Read "Discussions" for user questions/concerns
- Note maker responses (engagement quality)
- Check related products (competitive cluster)

### G2/Review Sites
- Filter by company size (different needs)
- Look at "Cons" sections (pain points)
- Check "Alternatives" comparisons
- Read 1-star and 5-star reviews (extreme feedback)

### Reddit
- Search: `productname alternative`
- Search: `productname vs competitor`
- Check r/SaaS, r/startups for B2B
- Check industry-specific subreddits

### App Stores
- Read recent reviews (current state)
- Check version history (update frequency)
- Look at screenshots (UX evolution)
- Check "Top In-App Purchases" (monetization)

### GitHub (for tech companies)
- Check org repos (engineering culture)
- Look at issue activity (community health)
- Check public discussions (roadmap hints)
- Analyze dependencies (tech choices)

---

## Common Pitfalls

1. **Marketing vs. Reality**: Trust user reviews over website claims
2. **Selection bias**: Angry users post more than satisfied ones
3. **Outdated info**: Check dates on everything
4. **Small sample**: One bad review ≠ bad product
5. **Confirmation bias**: Actively look for positive competitor attributes
6. **Static view**: Markets change — note the date of your analysis

---

## Quick Reference

```
INTELLIGENCE CHECKLIST
□ Official sources reviewed
□ User platforms checked (3+)
□ Third-party analysis gathered
□ Technical signals examined
□ Comparison matrix built
□ Sources cross-verified
□ White space identified
□ Output structured

KEY QUESTIONS
1. What do they claim?
2. What do users say?
3. What's missing?
4. Where's the opportunity?
```
