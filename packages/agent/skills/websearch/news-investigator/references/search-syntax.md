# Search Syntax Reference

Advanced search operators and query construction patterns for investigative news research.

---

## Universal Operators (work on Google, Bing, DuckDuckGo)

```
"exact phrase"          Match exact phrase — use for quotes, titles, specific claims
-word                   Exclude results containing word
site:domain.com         Restrict to specific domain
filetype:pdf            Find specific file types (pdf, doc, xls, ppt)
intitle:word            Word must appear in page title
inurl:word              Word must appear in URL
before:YYYY-MM-DD       Results published before date
after:YYYY-MM-DD        Results published after date
```

---

## High-Value Query Patterns

### Finding First Reports
```
"{event name}" after:YYYY-MM-DD before:YYYY-MM-DD
"{event name}" earliest OR "first reported" OR "breaking"
```

### Finding Primary Documents
```
"{event}" filetype:pdf site:gov
"{organization}" "press release" OR "statement" after:YYYY-MM-DD
"{event}" site:sec.gov OR site:eur-lex.europa.eu
```

### Filtering Out Aggregators
```
"{claim}" -"according to" -"reports say" -"sources say"
intitle:"{specific phrase}" (forces articles that are actually about it)
```

### Finding Corrections and Debunks
```
"{claim}" correction OR retraction OR debunked OR "fact check"
"{claim}" false OR misleading OR misinformation
site:snopes.com "{topic}"
site:fullfact.org "{topic}"
```

### Tracing Citation Origins
```
"{exact quote}" (finds all articles containing a specific quote)
"{claim}" -site:[outlet that first reported it] (find who else picked it up)
```

### Finding Eyewitness / Local Content
```
"{event}" site:reddit.com
"{event}" site:twitter.com (limited — better to search X directly)
"{event}" forum OR community OR residents OR locals
"{event}" [origin language keywords]
```

### Reverse Sourcing
```
link:[article URL] (Bing only — finds pages linking to an article)
"{distinctive phrase from article}" (finds who copied or cited it)
```

---

## Platform-Specific Syntax

### X (Twitter) Advanced Search
URL: `twitter.com/search-advanced`

```
from:username           Posts from specific account
to:username             Replies to specific account
min_faves:100           Minimum engagement threshold
lang:ja                 Filter by language
near:city within:50km   Geographic filter (approximate)
since:YYYY-MM-DD        After date
until:YYYY-MM-DD        Before date
filter:links            Posts with links only
filter:images           Posts with images
filter:videos           Posts with video
-filter:retweets        Exclude retweets
```

**Combined example** (finding early eyewitness posts in a disaster):
```
"{location}" earthquake since:2024-01-15 until:2024-01-16 filter:images lang:ja
```

### Reddit Search
```
site:reddit.com/r/{subreddit} "{query}"
```
Or use Reddit's own search with sort=new for chronological ordering.

### Wayback Machine
```
web.archive.org/web/YYYYMMDDHHMMSS*/[URL]
```
- `*` returns a calendar view of all captures
- Specific timestamp returns snapshot from that moment
- Use `web.archive.org/web/2*/[URL]` to get all captures from 2000s onward

### Google News (Advanced)
```
google.com/search?q={query}&tbm=nws&tbs=cdr:1,cd_min:MM/DD/YYYY,cd_max:MM/DD/YYYY
```
Useful for date-restricted news search when normal Google News filters are limited.

---

## Query Construction Strategy

### Step 1: Start broad, then narrow
```
[Wrong]:  "ministry of finance japan cryptocurrency regulation 2024 announcement"
[Right]:  "japan crypto regulation" → then add constraints based on what you find
```

### Step 2: Use multiple phrasings
The same event may be described differently in different outlets:
```
"forest fire" OR "wildfire" OR "bushfire" [location]
"data breach" OR "hack" OR "cyber attack" OR "security incident" [company]
```

### Step 3: Search the claim, not the event
If you want to verify a specific claim:
```
[Wrong]:  "the ukraine conflict" (too broad)
[Right]:  "{specific claim being verified}" (finds exactly who is saying it)
```

### Step 4: Vary your search engine
If Google returns nothing useful after 3 queries on a topic:
- Try Bing (different index, surfaces different small sites)
- Try DuckDuckGo (better for small/regional sites)
- Try the regional engine for the origin country

### Step 5: Search for absence
If a story seems too clean or one-sided:
```
"{event}" criticism OR controversy OR "not true" OR denied
"{official claim}" disputed OR challenged OR rebutted
"{organization}" OR "{person}" history OR "past" OR "track record"
```
