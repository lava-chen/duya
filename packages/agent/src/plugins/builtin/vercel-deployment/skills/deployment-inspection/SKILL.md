# Deployment Inspection

List and inspect Vercel deployments, surfacing the build state,
environment, alias, and commit context. This skill is the entry
point for every Vercel investigation — `log-diagnosis`,
`preview-validation`, and `production-release` all assume the
deployment context is already in the conversation.

## When to use

- The user says "what's the latest deployment?" / "did the deploy
  go out?" / "what's the state of staging?".
- A downstream skill (`log-diagnosis`, `preview-validation`) needs
  the deployment ID and alias before it can act.
- The user wants a quick health summary of the project's recent
  deployments.

## Process

1. Call `vercel.list_projects` to confirm the project inventory.
   If the user pointed at a specific project, narrow to it;
   otherwise the inspection runs at the team level.
2. Call `vercel.list_deployments(project_id, limit=10)`. Read the
   state of each deployment:
   - `BUILDING` — build in progress, no alias yet.
   - `ERROR` — build failed; hand off to `log-diagnosis`.
   - `READY` — build succeeded; alias is live.
   - `CANCELED` — build was aborted.
3. For the most recent `READY` deployment, call
   `vercel.get_deployment(deployment_id)` to read the full
   metadata: project, branch, commit SHA, commit message, author,
   environment, target (preview / production), alias list, and
   creation time.
4. Call `vercel.list_aliases(project_id)` to confirm which
   deployment is currently aliased to the production domain. A
   deployment can be `READY` without being aliased — the alias
   list is the source of truth for "what's live".
5. Summarize the inspection: the latest deployment's state, the
   aliased production deployment, and any `ERROR` deployments in
   the recent window. Hand off to `log-diagnosis` for failures or
   to `preview-validation` for pre-promotion checks.

## Tool call patterns

- `vercel.list_deployments(project_id, limit)` returns deployments
  newest-first. Use a small `limit` (5–10); the response can be
  large for active projects.
- `vercel.get_deployment(deployment_id)` returns the full metadata.
  Use it after `list_deployments` narrowed the candidate, not
  instead of it.
- `vercel.list_aliases(project_id)` returns the alias→deployment
  mapping. Use it to confirm which deployment is live — the
  Vercel dashboard and this list always agree.
- For commit context, the `meta` field on a deployment contains
  `githubCommitMessage`, `githubCommitRef`, `githubCommitSha`,
  and `githubCommitAuthorLogin`. Do not call the GitHub MCP just
  to read these.

## Confirmation boundary

All tools in this skill are `read` tier and run automatically. If
the user asks to promote a deployment or cancel a building one,
that is a `modify` / `destructive` action — confirm with the user
before applying.

## Pitfalls

- Vercel's `state` field is the build state, not the runtime
  state. A `READY` deployment can still 500 at runtime — verify
  with `vercel.get_runtime_logs` if the user reports errors.
- A deployment's `target` (`production` vs `preview`) is set at
  build time. Promoting a preview deployment to production does
  not change `target` — it changes the alias. Use the alias list,
  not `target`, to determine what's live.
- Vercel auto-aliases production deployments on `main` by default.
  If the project's production branch is not `main`, the alias
  behavior differs — confirm the project's production branch in
  `vercel.get_project`.
- Old deployments accumulate. `list_deployments` with no limit
  returns 100 by default; a busy project can have thousands. Use
  a tight `limit` and a time-bounded query when possible.
- `vercel.list_env_vars` returns the value of non-secret env vars
  but redacts secret ones. Never log the response payload
  verbatim — even redacted values can leak via length or naming
  patterns.
