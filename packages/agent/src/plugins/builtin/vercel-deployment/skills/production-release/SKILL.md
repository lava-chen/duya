# Production Release

Promote a verified deployment to production. This skill is the
single most dangerous action in the Vercel plugin — it is the only
one pinned to the `destructive` tier by default, because a
production promotion is irreversible from chat and immediately
affects every user.

## When to use

- The user says "promote this to production" / "ship it" / "make
  this live".
- `preview-validation` passed and the user confirmed the
  promotion.
- A rollback is needed — a previous promotion caused a regression
  and the user wants to revert to the prior production deployment.

## Process

1. Identify the deployment to promote. Either:
   - The user named one — read it via `vercel.get_deployment`.
   - Or pick the most recent `READY` preview deployment that
     passed `preview-validation`.
2. Re-confirm the deployment context one final time, in chat and
   immediately before the promote call:
   - Deployment URL and alias.
   - Commit SHA and commit message.
   - Author of the commit.
   - Preview-validation report (or a one-line "validation passed
     at <timestamp>").
3. Confirm with the user. This is the `destructive` tier
   confirmation — not a "yes/no" prompt, but an explicit opt-in:
   - Restate the deployment URL and commit SHA.
   - Restate what the change does (one sentence from the commit
     message).
   - Name the current production deployment that will be
     replaced (alias + commit SHA).
   - Ask the user to confirm with the exact phrase "promote to
     production" (or equivalent explicit confirmation).
4. After confirmation, call `vercel.promote_to_production(
   deployment_id)`. The call returns the new alias mapping; the
   promotion is synchronous at the alias level but may take 30–60
   seconds to propagate globally.
5. Verify the promotion:
   - `vercel.list_aliases(project_id)` shows the production alias
     now points at the promoted deployment.
   - Fetch the production URL via the Playwright plugin or HTTP
     and confirm it returns the expected content (e.g. the new
     version banner).
6. Report the promotion: production URL, deployment URL, commit
   SHA, and the previous production deployment (for rollback
   reference).

## Tool call patterns

- `vercel.promote_to_production(deployment_id)` is the canonical
  promote call. It does not rebuild — it re-aliases the existing
  deployment.
- `vercel.list_aliases(project_id)` confirms the alias mapping
  after promote. The production alias (`<project>.vercel.app` or
  the custom domain) should point at the promoted deployment.
- `vercel.get_deployment(previous_production_id)` returns the
  previous production deployment for rollback reference. Always
  surface its ID and commit SHA — a rollback without this context
  is guessing.

## Confirmation boundary

- Reading deployment context and aliases: `read` tier, automatic.
- Promoting to production: `destructive` tier, strong explicit
  confirmation every time. Never batch promotions. Never skip the
  re-confirmation step even if the user said "ship it" earlier —
  the state may have changed between validation and promotion.
- Rolling back production (re-aliasing to a previous deployment):
  `destructive` tier, same confirmation rule. The user must
  restate the rollback target explicitly.

## Pitfalls

- A promotion re-aliases, it does not rebuild. If the deployment
  was built with stale env vars, the promotion ships with those
  stale values. Always confirm the build env matches the
  production env in `preview-validation` before promoting.
- Vercel's global CDN propagation is fast but not instant. The
  production URL may serve the old version for 30–60 seconds
  after the promote call. Do not declare "shipped" until the
  verification fetch returns the new content.
- Custom domains and `<project>.vercel.app` aliases update
  together, but third-party CDNs in front of Vercel may cache
  longer. If the user reports "still seeing the old version",
  check the response headers (`x-vercel-id`) to confirm the
  request hit Vercel and not a cached edge.
- A rollback is a promote to an older deployment, not a delete of
  the current one. The current production deployment stays in the
  deployment list and can be re-promoted if the rollback was a
  mistake.
- Production promotions send a Slack / email notification to the
  team by default. Do not promote "to test the promotion flow" —
  every promotion is a real customer-facing change.
- If `vercel.promote_to_production` returns an error about a
  missing `production` target, the deployment was built for
  preview only. Re-deploy with `target=production` (or trigger
  via the project's production branch) and re-validate.
