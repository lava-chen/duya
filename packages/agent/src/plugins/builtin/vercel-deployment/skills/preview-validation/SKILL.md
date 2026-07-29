# Preview Validation

Deploy or pick a preview deployment and validate it against a
checklist before promoting to production. This skill is the gate
before `production-release` — it catches the regressions a build
check cannot.

## When to use

- The user says "validate the preview before we ship" / "is this
  safe to promote?".
- A PR is open and CI is green but the user wants a final
  functional check on the preview deployment.
- The user is about to run `production-release` and wants the
  validation report to attach to the confirmation.

## Process

1. Identify the preview deployment. Either:
   - The user named one (from a PR check, an email, or the
     Vercel dashboard) — read it via `vercel.get_deployment`.
   - Or pick the most recent `READY` deployment on the project's
     preview branch via `vercel.list_deployments(target=preview,
     state=READY, limit=1)`.
2. Read the deployment's commit context from `meta`: commit SHA,
   commit message, author, base branch. Confirm the deployment
   corresponds to the change the user wants to ship.
3. Build the validation checklist:
   - **Build state** — `state === READY`. If `ERROR`, hand off to
     `log-diagnosis` and stop.
   - **Build env parity** — env vars on preview match production
     (compare `vercel.list_env_vars(target=preview)` with
     `target=production`). Surface any diff.
   - **Smoke test** — fetch the preview URL and confirm the
     homepage returns 200. Use the Playwright plugin or a simple
     HTTP fetch. Check the page title matches the project name.
   - **Critical path** — for each user-named critical path (e.g.
     "login → dashboard → create item"), walk the path on the
     preview URL and confirm it succeeds. Use the Playwright
     plugin for stateful paths; use HTTP fetch for read-only
     paths.
   - **Console errors** — capture browser console messages on
     the critical path. Surface any new errors compared to the
     production deployment.
   - **Analytics signal** — if the project has Vercel Web
     Analytics, compare the preview's page-view count over the
     validation window against the production baseline. A
     zero-page-view preview is a sign the smoke test didn't
     actually render.
4. Report the checklist as a table. For each item, mark pass /
  fail / warn. For failures, propose a concrete next step
  (rebuild, fix code, update env var).
5. Only when every critical-path item passes, hand off to
  `production-release`. Otherwise stop and surface the blockers.

## Tool call patterns

- `vercel.list_deployments(project_id, target=preview, state=READY,
  limit=1)` returns the most recent ready preview deployment. Use
  the `meta` field for commit context.
- `vercel.list_env_vars(project_id, target)` returns env vars per
  target. Compare the `key` lists between `preview` and
  `production` — values for secret env vars are redacted, so the
  comparison is by name and target only.
- For smoke and critical-path checks, prefer the Playwright plugin
  (`playwright-web-operator`) over raw HTTP. SPAs may return 200
  for a blank page; Playwright confirms the page actually rendered.
- `vercel.get_web_analytics(project_id, deployment_id)` returns
  page-view counts. Use a short window (e.g. `5m`) for the
  validation period.

## Confirmation boundary

- Reading deployments, env vars, and analytics: `read` tier,
  automatic.
- Navigating the preview URL with the Playwright plugin: `read`
  tier, automatic (the preview is not customer-facing).
- Creating a new preview deployment when none exists: `write`
  tier, confirm with the user before triggering.
- Promoting to production: NOT this skill's responsibility —
  hand off to `production-release` which carries its own
  `destructive` confirmation.

## Pitfalls

- A preview deployment shares env vars with production by default;
  a missing preview-only override can mask a production-only bug.
  Always compare the env var targets explicitly.
- Preview URLs are unauthenticated by default. If the project
  requires auth, the smoke test will hit a login redirect —
  authenticate via the Playwright plugin's `browser.fill_form`
  before walking the critical path.
- Vercel's `READY` state does not include health checks. A
  deployment can be `READY` and 500 on every request. The smoke
  test must actually fetch a page, not just check the state.
- Preview deployments are ephemeral. A validation report run on
  preview A may not apply to preview B created 5 minutes later
  from a different commit. Always include the commit SHA in the
  report.
- The Vercel Web Analytics signal is delayed (typically 60s).
  A "zero page views" report immediately after the smoke test is
  expected; wait and re-check before treating it as a failure.
