# Log Diagnosis

Read Vercel build and runtime logs, classify the failure, and
propose a fix. This skill consumes the deployment context from
`deployment-inspection` and produces the diagnosis that the
project's fix path will act on (the fix itself goes through the
project's normal git workflow, not this plugin).

## When to use

- The user says "the build is failing on Vercel" / "this preview
  is erroring".
- `deployment-inspection` reported an `ERROR` deployment and the
  next step is to read the logs.
- A `READY` deployment is throwing 5xx at runtime and the runtime
  logs need to be inspected.

## Process

1. Read the deployment context from `deployment-inspection`.
   Confirm the deployment ID, branch, and commit SHA.
2. If the deployment state is `ERROR`, call
   `vercel.get_build_logs(deployment_id)`. The build log is a
   single string; parse by stage:
   - `Running build in <env>` — environment setup; check Node
     version, package manager.
   - `> <script>` — the npm script invoked; match against
     `package.json`.
   - `Failed to compile.` / `Error:` — the actual failure.
   - `Build completed` — the success marker; absence here means
     the build failed.
3. Classify the build failure:
   - **TypeScript / typecheck** — fix in source. The error
     includes file and line.
   - **Missing dependency** — `Cannot find module 'X'`. Fix by
     installing the package or fixing the import path.
   - **Build script error** — `npm run build` exited non-zero.
     Read the script in `package.json` to find the underlying
     command.
   - **Environment variable missing** — `ReferenceError: X is
     not defined`. Check the project's env vars via
     `vercel.list_env_vars`.
   - **Out of memory / timeout** — Vercel killed the build.
     Often caused by a circular import or an unbounded loop.
4. If the deployment is `READY` but the user reports runtime
   errors, call `vercel.get_runtime_logs(deployment_id)`. Filter
   by status >= 500 and read the stack traces. The runtime log
   shape is similar to the build log but is appended to over
   time — use a time window filter when the API supports it.
5. Propose a fix in chat. Reference the file and line, explain
   what's wrong, and show the proposed diff. Do not apply the
   fix from this skill — hand off to the project's normal git
   workflow.

## Tool call patterns

- `vercel.get_build_logs(deployment_id)` returns the full build
  log. Parse it locally — Vercel does not return structured error
  objects.
- `vercel.get_runtime_logs(deployment_id)` returns runtime logs.
  For projects on Vercel's Edge Runtime, logs are per-region;
  filter by region when the user reports a region-specific issue.
- `vercel.list_env_vars(project_id)` returns env vars. Secret env
  vars are redacted — only the name and target are visible. Use
  this to confirm presence, not value.

## Confirmation boundary

All activity in this skill is `read` tier — it reads logs and
inspects env var names. Applying a fix in the project's codebase
goes through the project's git workflow (or the GitHub
Development plugin), not this skill.

## Pitfalls

- Vercel's build log is the build log of the build machine, not
  of your local machine. A build that passes locally can fail on
  Vercel due to Node version, platform, or env var differences.
  Always cross-reference the build env in the log header with
  your local env.
- `vercel.get_runtime_logs` is eventually consistent. A 5xx that
  just happened may not be in the log yet — wait 30–60 seconds
  before declaring "no runtime errors".
- Edge Runtime logs are sampled, not exhaustive. A low-frequency
  error may never appear in the log; prefer client-side
  observability (Sentry) for Edge functions.
- Build logs for monorepo projects include the workspace
  resolution step. A `Cannot find module` error may be a
  workspace hoisting issue, not a missing dependency.
- `vercel.list_env_vars` returns env vars for all targets
  (`production`, `preview`, `development`). Filter by target
  before reporting — a missing production env var may exist on
  preview only.
