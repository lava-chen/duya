---
name: browser-research
description: Research a topic across live web sources with the duya browser tool, keeping provenance for every claim. Covers source discovery with search, batch reading with parallel_fetch, pulling structured data out of SPA pages, recovering data that only exists in XHR traffic, cross-checking conflicting sources, handling paywalls and login walls, and reporting findings with a source table. Use when the user asks a question whose answer lives on the web, wants a literature or market scan, asks to compare products or versions, or says research / look up / find out / survey.
allowed-tools: browser, vision_analyze, Read, Write
---

# Web research

Answer questions whose truth lives on the web, and keep every claim traceable
to a URL you actually read.

## Duya capability binding

The `browser` tool drives a real Chromium session over CDP and degrades
gracefully (extension -> sidebar webview -> static fetch) when a transport is
unavailable. It ships inside duya as `@duya/browser`, so there is nothing to
install, connect, or authenticate.

The tool publishes its own capability guide. **Read it once before your first
call**, in two steps: find the tool, then read it by its stable id.

```json
{"tool_id": "<the browser tool's stable tool_id>"}
```

Look that id up first with `{"query": "browser"}` or
`{"namespace": "builtin"}` rather than guessing it — `tool_catalog` accepts
only `query`, `tool_id`, `namespace` and `cursor`, and rejects any other
argument. The `tool_id` response carries `usage_guide`: the tool's own
operating manual, attached only at that point because you have already
committed to this tool. Read it before the first call — it documents the
operations, required arguments, and the failure modes that matter.

That guide is the single source of truth for the operation list, parameter
shapes, the network-environment decision table, and the safety rules. This
skill carries what the guide cannot: the research workflow and its failure
modes. Where this skill and the guide appear to disagree, the guide wins.

## The loop

1. **Scope before searching.** Restate the question as something a specific
   page could answer. "What is X" is not answerable; "X's current rate limit
   policy" is. If the question is genuinely too broad to answer, say so and
   propose a decomposition instead of searching ten times.

2. **Discover.** One `search` call replaces manual SERP navigation:

   ```json
   {"operation": "search", "query": "sqlite better-sqlite3 concurrency limit", "maxResults": 8, "engine": "auto"}
   ```

   `engine: "auto"` is the default and picks deterministically from the
   probed network environment. Leave it alone unless a specific engine is
   failing. The full enum is `auto | google | bing | baidu | duckduckgo |
   brave | yahoo | github` — `github` is the useful one for library and
   repository questions, and it is worth reaching for directly instead of
   searching the open web.

   A failed engine degrades automatically down the chain. If everything
   fails, the result carries `nextSteps`: **follow them** instead of
   improvising a different engine by hand.

3. **Read in batch.** Once you have candidate URLs, fetch them together
   rather than one at a time:

   ```json
   {"operation": "parallel_fetch", "urls": ["https://a.example/doc", "https://b.example/doc"], "useBrowser": false, "task": "find the documented concurrency limit"}
   ```

   `useBrowser: false` is a fast HTTP fetch with no JS rendering. Use it for
   documentation, blog posts, news, and reference pages. Keep `useBrowser:
   true` (the default) for anything that hydrates in the browser. Results are
   readable text plus interactive refs, never raw DOM.

   Pass `task` when you know what you are looking for — the fetcher uses it to
   focus each page instead of dumping everything.

4. **Verify against the primary source.** A search snippet and a blog
   paraphrase are both second-hand. For any claim you intend to state as
   fact, `navigate` to the authoritative page (the official docs, the spec,
   the release notes) and confirm the text is there. If the primary source
   contradicts the secondary one, the primary wins and you say so.

5. **Synthesise with provenance.** Report findings first, then a source table
   mapping each claim to its URL.

## Structured data on SPA pages

When the text you need is rendered client-side, or the page is one huge blob
of navigation, do not scroll-and-read. Map it down to the fields you need
inside the page:

```json
{"operation": "evaluate", "script": "(function(){ return Array.from(document.querySelectorAll('article')).slice(0,10).map(a => ({title: a.querySelector('h2')?.innerText, date: a.querySelector('time')?.dateTime, href: a.querySelector('a')?.href})) })()"}
```

Slice and project inside the script. Returning a whole list of full objects
gets truncated at the output cap and wastes the round trip.

Sites that hydrate from a JSON global (`window.__INITIAL_STATE__`,
`window.ytInitialData`, and similar) return far cleaner data that way than
through DOM scraping. Look for it before falling back to selectors.

## When the data only exists in XHR

Some pages render nothing useful but call a JSON endpoint behind the scenes.
Arm capture, then let the page load, then read it:

```json
{"operation": "network_start", "pattern": "/api/"}
{"operation": "navigate", "url": "https://example.com/feed"}
{"operation": "network_read"}
```

`network_start` takes an optional `url` so navigation happens after capture is
armed, which avoids missing the first requests. Both `network_start` and
`network_read` fail in fallback mode (no CDP transport) — if you get that
error, the page must be read through the DOM instead.

## Cross-checking

- A factual claim that will drive a decision needs **two independent
  sources**. Two articles that both cite the same press release are one
  source.
- When sources disagree, report the disagreement and say which one you trust
  and why (primary over secondary, newer over older, measured over claimed).
  Do not silently average them.
- Absence of evidence is a finding. "No source I found states X" is a valid,
  reportable result — label it as a search result, not as a fact about the
  world.

## Blockers you must report, not defeat

- **Paywall** — say the content is paywalled. Do not hunt for a pirated copy
  or an unauthorised mirror.
- **Login wall** — if the user's session is not signed in, stop and ask. Do
  not attempt to log in with guessed credentials.
- **CAPTCHA / bot challenge** — stop and ask the user to solve it in the
  visible window. Never try to bypass one.
- **Rate limit or block** — slow down and report. Do not rotate identities or
  otherwise evade it.
- **Network-unreachable domain** — the tool's guide names the fallback search
  engines for the detected environment. Switch once, report the switch, and
  if that also fails, say the source was unreachable.

Never invent a URL, a quote, or a statistic. If a page did not load, it is not
a source.

## Output standards

Lead with the answer, then the evidence:

- Findings as prose or a tight list, each substantive claim carrying its URL
  inline.
- A source table with the URL, what it supports, and its authority level
  (primary / secondary / community).
- An explicit "not found" or "unverified" line for anything you set out to
  find and could not confirm. Do not leave the gap silent.
- For blockers, name the exact gate: paywall, login wall, CAPTCHA, rate
  limit, or network unreachable.

## Cleanup

Call `{"operation": "close_window"}` when the research is done. It closes the
automation window and releases the page resources. Do not leave a session
open across an unrelated task.
