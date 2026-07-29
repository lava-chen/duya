# Structured Extraction

Scrape structured data out of a web page: tables, lists, repeated
cards, JSON-LD. Produces a JSON object the user can save, query, or
pipe into another tool.

## When to use

- The user says "get me all the items from this table" / "scrape the
  search results" / "extract the product cards".
- A page contains structured data you need to turn into a CSV / JSON /
  Markdown table.
- You need to compare two pages' content programmatically.

## Process

1. `browser_navigate` to the page (or use the current tab).
2. `browser_snapshot` to capture the accessibility tree. Identify the
   repeating container that holds one record each (e.g. `<li>` per
   row, `<article>` per card).
3. If the data is in a table, the snapshot already exposes row/cell
   structure — extract from there first.
4. For complex layouts, use `browser_evaluate` with a `() => { ... }`
   arrow function that returns a JSON-serializable array. Query
   within the document, do not mutate.
5. For JSON-LD, `browser_evaluate` reading
   `document.querySelectorAll('script[type="application/ld+json"]')`
   returns the structured payload directly.
6. Paginate by following the "next" link with `browser_click` and
   re-extracting. Stop when the next link is missing or disabled.
7. Report the extracted dataset as a compact JSON or Markdown table.
   Show the row count and the first 3 rows for verification.

## Tool call patterns

- `browser_evaluate` with a `return` statement is the most flexible
  extractor. Keep the function pure (no side effects) and return only
  JSON-serializable values.
- `browser_snapshot` exposes text content for many layouts without
  custom JS — try it first.
- For paginated APIs embedded in the page (e.g. `__NEXT_DATA__`),
  read the embedded JSON instead of scraping the rendered DOM.

## Confirmation boundary

- All extraction is `read` tier. The browser never mutates during
  scraping.
- If the page requires login, the user must already be authenticated
  in the MCP browser profile. Do not log in as part of this skill —
  hand off to `form-operation` with explicit confirmation.

## Pitfalls

- Lazy-loaded content may not be in the snapshot. Scroll to the
  bottom (or trigger the infinite scroll) before extracting.
- Anti-scraping sites can detect headless browsers. If extraction
  returns an empty set on a clearly populated page, suspect detection.
- Large result sets blow up the chat context. Cap to ~100 rows in the
  report; save the full set to a file in the workspace.
