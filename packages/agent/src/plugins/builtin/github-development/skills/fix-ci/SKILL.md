# Fix CI

Diagnose a failing GitHub Actions run, localize the failure, fix it,
and push. This skill turns "the build is red" into a green pipeline
without dropping context between log inspection and code change.

## When to use

- The user says "CI is failing on PR #N" or "the build broke".
- A `push` or `pull_request` event shows a failing status.
- The most recent run on `main` is red and blocking a release.

## Process

1. `actions.list_runs` on the repo, filtered by branch and
   `status=completed`, `conclusion=failure`. Take the most recent.
2. `actions.list_jobs` on the run. Identify the failing job(s) — a run
   can have multiple jobs and only some fail.
3. For each failing job, `actions.get_job_logs`. Logs can be large;
   focus on the failing step first, then expand only if the cause is
   upstream.
4. Classify the failure:
   - **Build / compile error** — locate the file and line in the error
     message; the fix is usually local.
   - **Test failure** — read the test name and assertion; reproduce
     locally before changing code.
   - **Lint / typecheck** — apply the suggested fix; do not disable
     the rule unless the user agrees.
   - **Environment / install** — check `package.json` / lockfile /
     Dockerfile; usually a dependency version mismatch.
5. Implement the fix in the workspace. Run the failing command
   locally to confirm it goes green.
6. Push the fix on the same branch the failing run came from. Use a
   conventional commit like `fix(ci): <what was wrong>`.
7. Watch the next run via `actions.list_runs` — do not assume green
   until the run completes.

## Tool call patterns

- `actions.list_runs` supports filtering by `branch`, `event`, and
  `status`. Use `event=pull_request` when working on a PR.
- `actions.get_job_logs` returns the full log blob. Parse by
  `##[group]` / `##[endgroup]` markers; the failing step is usually
  the last one before a non-zero exit.
- For matrix builds, each job has its own `id`; iterate jobs rather
  than reading the whole run log.

## Confirmation boundary

- Reading runs, jobs, and logs: `read` tier, automatic.
- Pushing the fix to an existing branch: `modify` tier, confirm.
  Show the diff before pushing.
- Force-pushing or deleting the branch: `destructive` tier, strong
  confirmation. Avoid unless the user explicitly asks — rebase
  instead of force-push whenever possible.

## Pitfalls

- Flaky tests look like real failures. If a test fails intermittently
  across runs, suspect flakiness before changing code; check the
  timing in the log.
- Cached dependencies can mask a fix. If the job uses
  `actions/cache`, a rerun may be needed before the fix takes effect.
- Do not commit a "fix" that just disables the failing test. The
  user almost always wants the actual root cause fixed.
