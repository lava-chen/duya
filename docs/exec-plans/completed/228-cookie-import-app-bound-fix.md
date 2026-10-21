# Cookie Import App-Bound + Live Export Hardening

> Lightweight follow-up to [227-built-in-browser-fallback](./completed/227-built-in-browser-fallback.md).

**Goal:** Fix remaining cookie-import pain points: v20 app-bound cookies still producing large failure counts when the Chrome extension is unavailable, and the requirement to close Chrome when the database is locked.

**Scope:**
- Ensure v20 app-bound cookies automatically fall back to the connected browser extension.
- Ensure a locked/blocked cookie database falls back to the connected browser extension.
- Give the user actionable UI guidance when the extension is required but not connected.
- Add/update unit tests for both fallback paths.

---

## Tasks

- [x] **Task 1: Verify IPC handler fallback logic**
  - Reviewed `electron/ipc/browser-cookie-handlers.ts`; v20 + busy paths already fall back to `exportLiveExtensionCookies`.
  - Added `APP_BOUND_EXTENSION_UNAVAILABLE` to `BrowserCookieAPI` type in `electron/preload.ts`.

- [x] **Task 2: Improve UI guidance**
  - Updated `src/components/settings/BrowserAdvancedSection.tsx`:
    - Uses `useBrowserExtension` to know extension connection state.
    - Shows a persistent hint when the extension is not connected.
    - `APP_BOUND_EXTENSION_UNAVAILABLE` and `COOKIE_DATABASE_BUSY` now include CTA buttons to open `chrome://extensions/` and refresh status.
  - Added i18n keys in `src/i18n/en.ts` and `src/i18n/zh.ts`.

- [x] **Task 3: Add/update unit tests**
  - Extended `electron/ipc/__tests__/browser-cookie-handlers.test.ts`:
    - v20 detected + extension succeeds → writes extension cookies.
    - v20 detected + extension unavailable → falls back to DB cookies with `APP_BOUND_EXTENSION_UNAVAILABLE`.
    - v20 detected + extension belongs to different browser → falls back to DB cookies.

- [x] **Task 4: Run verification**
  - `npm run typecheck:all` ✅
  - `npm run test -- electron/ipc/__tests__/browser-cookie-handlers.test.ts` ✅ (5/5)

- [x] **Task 5: Update plan and commit**
  - Marked checkboxes done.
  - Moved this plan to `docs/exec-plans/completed/`.
  - Updated `docs/exec-plans/README.md`.
  - Committed with Conventional Commits format.

## Outcome

Cookie import now prefers the connected browser extension whenever v20 app-bound records are present or the SQLite database is locked, removing the need to close Chrome when the extension is available. UI messages explain why and give direct actions when the extension is missing.
