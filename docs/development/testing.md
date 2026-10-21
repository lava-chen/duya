# Testing

DUYA uses a three-layer testing strategy. Pick the layer that matches the question
you're asking.

## 1. Unit tests (Vitest, fast, no Electron)

- **Runner**: `vitest` 3.x. Config: `vitest.config.ts`.
- **Location**:
  - `packages/ui/src/**/*.test.ts` / `*.test.tsx` — colocated with renderer code
  - `packages/*/tests/**/*.test.ts` — colocated with workspace package code
  - `apps/desktop/src/main/ipc/__tests__/*.test.ts` — IPC handler unit tests
- **Run**: `npm run test`, `npm run test:watch`, `npm run test:coverage`.
- **IPC handler test pattern** (critical): see
  `apps/desktop/src/main/ipc/__tests__/url-safety.test.ts` (pure function) and
  `apps/desktop/src/main/ipc/__tests__/logger-handlers.test.ts` (mocked module).
  - All mock state must live inside `vi.hoisted(() => ({ ... }))` so the
    `vi.mock` factory (also hoisted) and the test bodies share one singleton.
  - `vi.mock` paths are **relative to the test file**, not the source file.
    From `apps/desktop/src/main/ipc/__tests__/foo.test.ts`, the logger module is
    `'../../logging/logger'`, not `'../logging/logger'`.
  - For a stable `getLogger()` mock, return `mocks.logger` from the factory — not a
    fresh object each call (otherwise `mockReturnValueOnce` calls are lost between tests).

## 2. E2E tests (Playwright `_electron`, real binary)

- **Runner**: `@playwright/test` driving the real Electron main process via the
  `_electron` API. See `e2e/playwright.config.ts`.
- **Location**: `e2e/smoke/smoke.spec.ts`, `e2e/ipc/*.spec.ts`.
- **Run**: `npm run test:e2e`, `npm run test:e2e:smoke`, `npm run test:e2e:ipc`.
- **Requires**: `npm run electron:build` first (produces `dist-electron/`).
  The Vite dev server is auto-started by Playwright's `webServer` config
  (`reuseExistingServer: true` lets you run `npm run dev` in parallel).
- **Isolation**: each spec passes a unique `--duya-namespace=<name>` so its userData
  (and SQLite DB) is fresh. `DUYA_TEST=1` enables test-mode hooks
  (single-instance bypass, no DevTools, etc.).
- **Pattern**: `helpers.ts` exports `launchDuya({ namespace })` and
  `invokeApi(page, 'settings.get', 'key')` which calls into `window.electronAPI` in the
  renderer. `closeDuya()` force-kills the process tree on Windows if the graceful close
  times out.

## 3. UI verification (Playwright MCP, dev server only)

- For interactive UI smoke checks during development. Start the Vite dev server first
  (`npm run dev`), then use MCP tools.
- Example: `mcp__playwright browser_navigate http://localhost:3000`,
  `mcp__playwright browser_snapshot`.

## Running tests from a worktree

Run vitest **from the repository root**. The root config's `setupFiles` resolve
relative to the root, so running `npx vitest` inside a package makes every suite fail
on a missing `test-setup.ts`.

## Test debt

`npm test` is red by design today (pre-existing debt). The red is the signal and it is
deliberately left visible in CI — no `|| true`, no `continue-on-error`, no glob skips.

**A full parallel vitest run is not a usable gate**: workers time out under parallel
load and report dozens of false failures on top of the real red. To decide whether a
change regressed anything, run the affected package's suites **serially** and compare
against a stashed baseline.
