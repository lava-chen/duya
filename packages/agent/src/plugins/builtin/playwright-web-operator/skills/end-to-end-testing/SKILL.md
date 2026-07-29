# End-to-End Testing

Generate and run an end-to-end test from a spec or a user story. This
skill produces a Playwright test file that can be checked into the
repo and re-run by CI.

## When to use

- The user says "write an E2E test for this flow" / "generate a
  regression test for the login page".
- A bug was just fixed and you want to lock in the fix with a test.
- A new feature landed and the spec includes an acceptance scenario.

## Process

1. Identify the user flow to test. Write it down as a numbered list
   of actions before touching the browser.
2. Drive the flow manually once with the Playwright MCP:
   navigate, snapshot, click, fill. Record the exact `ref`s and
   selectors that worked.
3. Translate the manual trace into a Playwright test file in
   `e2e/<feature>.spec.ts`. Use the project's existing test
   conventions — check `e2e/` for prior patterns.
4. The test should:
   - Set up prerequisites (test data, mock APIs) in `beforeAll`.
   - Assert at each step, not just at the end.
   - Clean up after itself (delete test records, reset state).
5. Run the test with `npm run test:e2e` (or the project's E2E
   command). Watch for flakiness — re-run at least twice before
   declaring it green.
6. Report: test file path, pass/fail status, any flaky steps. If the
   test fails, debug and fix before reporting back.

## Tool call patterns

- `browser_snapshot` during manual tracing gives you the `ref`s you
  will use in the test (via `getByRole` / `getByLabel`).
- `browser_evaluate` to read `data-testid` attributes if the project
  uses them — test IDs are the most stable selector.
- `browser_console_messages` during the trace catches errors the
  test should assert do not happen.

## Confirmation boundary

- Driving the browser to trace the flow: `read` tier, automatic for
  local pages; `write` tier for clicks on production pages — confirm.
- Writing the test file: file edit, no MCP confirmation needed.
- Running `npm run test:e2e`: spawns a real browser; safe to run
  locally without confirmation.

## Pitfalls

- Playwright tests are flaky by default. Add explicit `await`
  assertions (`await expect(locator).toBeVisible()`) instead of
  fixed `setTimeout` waits.
- Test data that depends on the current date or environment will
  break in CI. Parameterize via env vars and provide defaults.
- Do not commit tests that require manual setup. The test must be
  runnable from a clean checkout with `npm install && npm run
  test:e2e`.
- AGENTS.md notes: Playwright E2E requires `npm run electron:build`
  first if testing Electron. Skip Electron E2E in this skill unless
  the user explicitly asked — it has a separate runner.
