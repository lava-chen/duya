# Plan 524: Browser Tab Group Management

**Status**: Implementation complete, manual smoke test pending
**Date**: 2026-09-12
**Motivation**: Mainstream agent browser extensions (Claude for Chrome et al.)
manage agent pages as labeled tab groups inside the user's own window instead
of spawning dedicated windows. DUYA's extension backend used a dedicated
automation window and the Playwright backend launched one Chromium per
parallel task — both produce window sprawl.

## Goal

Agent pages appear as grouped tabs of a single browser window, per agent
session, with automatic fallback where grouping is impossible.

## Phase 1 — Extension backend: chrome.tabGroups (done)

- [x] `extension/manifest.json`: add `tabGroups` permission; update description.
- [x] `extension/background.js`: replace `getOrCreateAutomationWindow()` as the
      default host with `resolveSessionWindowId()` — the user's last focused
      normal window when the tabGroups API is available.
- [x] Per-session tab group: `ensureSessionGroup()` assigns each session's tabs
      to one labeled group (`DUYA · <session>`, deterministic color from the
      session id hash); `SessionState` gains `groupId`.
- [x] `tabs list` op lists from the session ownership map instead of querying
      by `windowId` (tabs may live in any window now).
- [x] `chrome.tabGroups.onRemoved` clears stale `groupId` when the user
      dissolves a group; `windows.onRemoved` cleanup now only applies to the
      fallback window.
- [x] Fallback preserved: no tabGroups API (Chromium forks), incognito, or
      non-normal focused window → legacy dedicated automation window, which
      still auto-closes when the last session ends.

## Phase 2 — Playwright backend: shared browser singleton (done)

- [x] `CDPClient.ts`: module-level `SharedPlaywrightBrowser` (browser + one
      context) with refcounting; each `PlaywrightCDPClient` owns one page, so
      parallel sessions render as tabs of a single headed window instead of
      one window per task.
- [x] `close()` closes only the session's page; the Chromium exits when the
      refcount hits zero. `acquireSharedPlaywright()` retries (max 2) if the
      browser died between launch and acquire.
- [x] `tabs()`/`newTab()`/`closeTab()`/`selectTab()` scoped to session-owned
      pages (previously they iterated the whole browser).
- [x] Storage trade-off documented: cookies/localStorage are shared across
      sessions, matching the extension backend's behavior on the user profile.
- [x] Unit tests: `__tests__/playwright-shared-browser.test.ts` (multiplexing,
      refcount liveness, per-session page scoping, relaunch after release).

## Verification

- `npx vitest run packages/agent/src/tool/BrowserTool/` — 75 passed (8 files).
- `npm run typecheck:all` — clean.
- Pending: manual smoke in a real Chrome + Electron renderer (load the
  unpacked extension, run a browser task, confirm the grouped tab appears in
  the user's window and dissolves cleanly; repeat in a Chromium fork to
  exercise the dedicated-window fallback).

## Follow-ups (not in this plan)

- Settings toggle to force the dedicated automation window (daemon already
  pushes `config` messages to the extension — add a `groupTabs: false` flag).
- Collapse the session group while idle; expand on next command.
- Webview backend: visual session grouping in BrowserPanel tab strip.
