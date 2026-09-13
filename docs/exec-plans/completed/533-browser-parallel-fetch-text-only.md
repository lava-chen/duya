# Plan 533 — `parallel_fetch` returns text, not DOM structure

**Status:** ✅ Complete (2026-09-13)

## Problem

`parallel_fetch` was returning a serialized DOM structure instead of page text,
in both of its engines. The user expected a text-only research primitive:
"只有获取结构的 action 才抓结构，并行抓取只抓文本内容".

Two independent defects produced the structure output:

1. **Generic extractor was never wired as the default.**
   `PlatformHookManager.indexExtractors()` probes each extractor's `matches()`
   against a fixed sample-host list that included `example.com`. The generic
   `article` extractor matches *every* http(s) URL, so the probe marked it
   `indexed` and it was never assigned to `defaultExtractor`. The slot instead
   went to the first extractor matching no sample host (the `arxiv` extractor).
   Net effect: `getExtractor()` returned `null` for ordinary sites, so
   `BrowserPool.investigate()` skipped the readability path and fell back to the
   structured snapshot capture.
2. **The static path's text serializer dropped all text.**
   `ParallelFetcher` built a tag tree via `compressHtml`, whose `getTagText()`
   only read `element.children`. `parseHtmlSimple()` stores an element's own text
   in `element.raw` (never in `children`), so the output was a text-less skeleton
   such as `"  [1]<a href=/ />\n<nav />\n<article />"`.

## Changes

- `packages/agent/src/tool/BrowserTool/platform-hooks/PlatformHookManager.ts`
  — assign `article` to `defaultExtractor` before the sample-host probe (and
  continue); drop `example.com` from the sample list; collect unpinned
  extractors into `fallbackExtractors` and scan them in `getExtractor()`.
- `packages/agent/src/tool/BrowserTool/SnapshotEngine.ts` — add public
  `capturePlainText()` (visible text only, length-capped).
- `packages/agent/src/tool/BrowserTool/BrowserPool.ts` — the no-extractor
  fallback uses `capturePlainText()` instead of the structured snapshot; refs
  are harvested from a separate `interactiveOnly` capture.
- `packages/agent/src/tool/BrowserTool/ParallelFetcher.ts` — add
  `htmlToPlainText()` and use it as the only content path; delete the
  demonstrably broken structure serializer (`compressHtml`, `getTagText`,
  `serializeAttributes`, `capText`, `isLandmarkTag`) and the unused
  `FetchTask.extract` field.
- `packages/agent/src/tool/BrowserTool/actions/parallel.ts` — update the
  `useBrowser` description; drop the dead `extract` task field.
- `packages/agent/src/tool/BrowserTool/prompt.ts` — document that results carry
  text content plus interactive refs, never DOM structure.

Engine selection is unchanged: extension CDP / Duya browser plugin vs built-in
browser are still chosen exactly as before.

## Verification

- `npx vitest run packages/agent/src/tool/BrowserTool/__tests__/` → 85 passed
  (10 files), including 2 new files:
  - `platform-hook-extractor.test.ts` — arbitrary hosts resolve to the `article`
    fallback; platform-specific hosts still win; `arxiv` still resolves.
  - `parallel-fetcher-text.test.ts` — static path strips tags/scripts/styles,
    keeps readable text, and recovers text stored only in `element.raw`.
- `npm run -w @duya/agent typecheck` → clean.
- Pre-existing, unrelated: `npm run typecheck:web` fails at HEAD on
  `src/components/layout/app-sidebar.tsx:56` importing
  `@/components/ui/DropdownMenu`, a file that is untracked in the primary
  checkout (another session's in-flight work). Not touched by this plan.

## Decision log

- Kept `useBrowser` default `true` and the existing engine selection — the ask
  was about output shape, not which engine renders the page.
- Removed the structure serializer rather than keeping it as an opt-in: it was
  unreachable from the tool schema, produced no text, and keeping it would have
  left a broken code path behind.
