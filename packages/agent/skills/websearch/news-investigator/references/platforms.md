# Platform Reference Guide

Platform-specific strategies for news investigation. Read sections relevant to your event type and origin region.

## Table of Contents
1. [Search Engines by Region](#search-engines)
2. [Social Platforms](#social-platforms)
3. [Wire Services & Aggregators](#wire-services)
4. [Specialized Databases](#specialized-databases)
5. [Archive & Verification Tools](#archive-tools)
6. [Platform Trust Matrix](#trust-matrix)

---

## 1. Search Engines by Region {#search-engines}

**Default assumption: Google is NOT the best engine for all stories.**

| Region | Primary Engine | Secondary | Notes |
|--------|---------------|-----------|-------|
| China (mainland) | Baidu | — | Google blocked; Baidu has local content Google lacks |
| Russia / CIS | Yandex | Mail.ru | Far better Russian-language coverage than Google |
| South Korea | Naver | Daum | Korean news ecosystem largely lives on Naver |
| Japan | Yahoo Japan | — | Aggregates Japanese press better than Google |
| Czech / Slovak | Seznam | — | Strong local news aggregation |
| Global (small sites) | DuckDuckGo | Bing | Surfaces smaller domains Google deprioritizes |
| Academic / Reports | Google Scholar | BASE | For NGO reports, white papers, research |
| Dark web / leaked | — | — | Note existence; do not access |

**For all regions**: Always try the origin-language query even if you then read results through translation. The query language affects what surfaces.

---

## 2. Social Platforms {#social-platforms}

### X (formerly Twitter)
**Strength**: Speed. Breaking events appear here 10–60 minutes before major outlets.  
**Weakness**: Noise, misidentification, deliberately false content spreads fast.

Effective search patterns:
- Use `until:YYYY-MM-DD` and `since:YYYY-MM-DD` to find earliest mentions
- Search in origin language — non-English events are heavily discussed in native language
- Filter: `filter:links` to find posts with sourced content
- Filter: `filter:verified` for official/institutional accounts (but verified ≠ truthful)
- Look at quote-tweets of early posts — often where corrections and debunks live
- Check accounts of local journalists in the affected region — they often post raw observations before filing stories

**X trust rule**: Treat as T4 unless: (a) posted by a named institutional account, (b) contains verifiable multimedia, or (c) corroborated by T2+ source.

### Reddit
**Strength**: Community knowledge, especially for niche/technical events. Threads accumulate verified info over time.  
**Weakness**: Subreddit-specific bias; early threads may contain speculation treated as fact.

Key subreddits by event type:
- r/worldnews — international events (heavily moderated for sources)
- r/news — US-centric
- r/geopolitics — political/conflict analysis
- r/collapse, r/environment — environmental/climate events
- r/wallstreetbets, r/investing — financial events (noisy but fast)
- Country-specific subs (r/germany, r/india, etc.) — local perspective
- Topic-specific subs (r/aviation for air incidents, r/cybersecurity for breaches)

Sort by "New" first to find earliest discussion, then by "Top" to see what the community validated.

### Telegram
**Strength**: Primary channel for conflict reporting (especially Russia/Ukraine/Middle East), government leaks, local crisis updates.  
**Weakness**: No moderation, channels often have clear political agendas, content hard to verify.

Search via: `t.me/s/[channel_name]` for public channels. Use third-party Telegram search tools (tgstat.com, telemetr.io) to find relevant channels.

**Telegram trust rule**: Treat as T4-T5 by default. Useful for leads; never cite as primary. Exception: when an official government or institution runs a verified Telegram channel.

### Facebook / Meta
Less useful for breaking news in Western markets but critical for:
- Southeast Asian events (Facebook is primary internet in many areas)
- Community-level local events
- Diaspora community reactions to home-country events

Search via CrowdTangle (if available) or directly in Facebook search with date filters.

### YouTube
**Strength**: Raw video footage — citizen journalism, livestreams, press conferences.  
**Use for**: Finding unedited video that predates edited news packages. Sort by upload date. Check video description for location/context data.

### LinkedIn
**Use for**: Verifying professional identities of named sources. If a "senior executive" or "industry insider" is quoted, check their LinkedIn to confirm their actual role.

---

## 3. Wire Services & Aggregators {#wire-services}

Wire services are the backbone of international news. Most outlet reporting traces back to them.

| Service | Origin | Strength |
|---------|--------|----------|
| Reuters | UK/global | Most cited; strong on finance, politics |
| AP (Associated Press) | US | Authoritative for US events; global reach |
| AFP (Agence France-Presse) | France | Strong on Africa, Francophone world |
| dpa | Germany | German and European events |
| Kyodo / Jiji | Japan | Japanese events |
| Xinhua | China | China events — note state-owned, editorial bias |
| TASS | Russia | Russia events — note state-owned, editorial bias |
| ANI / PTI | India | South Asian events |

**Wire service strategy**: If you find a report citing "according to Reuters," always fetch the actual Reuters article to verify the claim and see what was omitted in the secondary report.

**News Aggregators** (use for discovery, not as primary sources):
- Google News: fast but may miss small outlets
- AllSides: shows same story from left/center/right outlets
- Ground News: bias detection overlay
- Mediastack API: programmatic news search across sources

---

## 4. Specialized Databases {#specialized-databases}

### Legal & Government Documents
- **PACER** (pacer.gov): US federal court filings
- **SEC EDGAR** (sec.gov/edgar): US company filings, financial disclosures
- **Regulations.gov**: US regulatory documents and comments
- **EUR-Lex**: EU legislation and official documents
- **national parliament websites**: Hansard (UK), Congressional Record (US), etc.

### Academic & Research
- **arXiv**: Physics, CS, math, economics preprints — often months ahead of journals
- **SSRN**: Social science, law, finance working papers
- **PubMed**: Medical/health research
- **Google Scholar**: Cross-disciplinary; useful for finding expert context

### Financial
- **Bloomberg / Reuters terminals** (if access available): Real-time financial data
- **SEC filings**: Quarterly/annual reports, material event disclosures (8-K)
- **OpenCorporates**: Company registration data globally
- **ICIJ Offshore Leaks**: Database of offshore financial entities

### Conflict & Crisis
- **ACLED** (acleddata.com): Conflict event data with location/date/type
- **GDELT Project**: Event database derived from global news
- **Bellingcat Checklists**: Open-source investigation methodology guides
- **FlightAware / Flightradar24**: Aircraft tracking (useful for conflict/incident verification)
- **MarineTraffic**: Ship tracking

### Environment & Disaster
- **ReliefWeb**: Humanitarian crisis reports from NGOs
- **USGS**: Earthquake/geological data
- **NOAA**: Weather and climate event data
- **Copernicus Emergency Management**: Satellite imagery of disasters

---

## 5. Archive & Verification Tools {#archive-tools}

### Web Archives
- **Wayback Machine** (web.archive.org): Primary tool. Search any URL for historical snapshots. Use `web.archive.org/web/*/[URL]` for full snapshot calendar.
- **archive.today** (archive.ph): Often captures pages Wayback misses; good for paywalled content snapshots
- **CachedView**: Google and Bing cache aggregator

**How to use effectively:**
1. When you find a key article, immediately check its Wayback history
2. Compare earliest capture to current version — silent edits are significant
3. If a page 404s, Wayback may have the original content
4. For very recent pages (last 48h), use Google Cache before it expires

### Image & Video Verification
- **Google Reverse Image Search**: Find original source of photos
- **TinEye**: More thorough reverse image search, shows date first indexed
- **InVID / WeVerify**: Video verification tool — extracts keyframes for reverse search, checks metadata
- **Forensically** (29a.ch/photo-forensics): Image manipulation detection
- **YouTube Data Viewer** (Amnesty International): Extract upload timestamps and geolocation from YouTube videos

### Geolocation Verification
- **Google Street View**: Verify photos/videos against known location
- **Sentinel Hub**: Free satellite imagery with historical comparison
- **SunCalc** (suncalc.org): Determine approximate time of day from shadows in images
- **GeoGuessr skills**: Match architectural styles, vegetation, road markings to regions

### Identity Verification
- **LinkedIn**: Professional role verification
- **Whois / DomainTools**: Domain registration history — who owns a website and since when
- **Media Bias/Fact Check**: Track record of news outlets

---

## 6. Platform Trust Matrix {#trust-matrix}

Quick reference for assigning initial tier before full credibility assessment.

| Platform/Source Type | Default Tier | Upgrade conditions |
|---------------------|--------------|-------------------|
| Wire service (Reuters, AP, AFP) | T2 | Named source → T1.5 |
| Major national newspaper | T2 | Own reporting (not aggregated) |
| Government official statement | T1–T2 | T1 if primary doc, T2 if press release |
| Academic paper (peer-reviewed) | T1–T2 | Based on methodology quality |
| NGO report | T2 | If methodology disclosed |
| Local/regional outlet | T2–T3 | Depends on reporting depth |
| Wire aggregator (Yahoo News) | T3 | If original wire source identified |
| X/Twitter (named journalist) | T3–T4 | T3 if corroborated |
| X/Twitter (institutional account) | T2–T3 | If verified account |
| X/Twitter (anonymous/pseudonym) | T4–T5 | T4 if contains verifiable artifact |
| Reddit thread | T4 | T3 if well-sourced community wiki |
| Telegram channel | T4–T5 | T4 if official channel |
| Blog / personal site | T4–T5 | T3 if author verifiable expert |
| Unknown website | T5 | Research ownership before upgrading |
| AI-generated summary | T5 | Never upgrade — always find primary |
