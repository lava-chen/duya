# Release Notes

Generate release notes for a GitHub release from a milestone, a tag
range, or a list of commits. Produces a draft the user can edit before
publishing.

## When to use

- The user says "cut release X" or "what changed since v0.1.4?".
- A milestone is closed and the user wants to ship.
- The repo follows a tag-based release flow and a new tag is about to
  be pushed.

## Process

1. Identify the previous tag with `tags.list` (sorted by version). If
   the user gave a milestone name, `issues.list(milestone=...)` to
   scope the changes.
2. `repos.list_commits` between the previous tag SHA and HEAD. For
   tag range, set `sha` to HEAD and filter by `since=<prev-tag-sha>`.
3. Classify every commit by Conventional Commit type:
   - `feat:` → **Features**
   - `fix:` → **Bug Fixes**
   - `perf:` → **Performance**
   - `refactor:` → **Refactors**
   - `docs:`, `test:`, `build:`, `ci:`, `chore:` → **Maintenance**
   - `BREAKING CHANGE:` footer or `!` → **Breaking Changes**
4. Group the commit list under each heading. Drop pure-noise commits
   (e.g. `chore: bump deps` with no behavior change) unless the user
   asked for a full log.
5. Produce a draft body. Match the repo's existing release-notes style
   — check `releases.list` for prior formats.
6. Show the draft to the user. Do not call `releases.create` until
   the user approves.

## Tool call patterns

- `tags.list` returns refs; resolve each to a commit SHA via `tags.get`
  or `repos.get` on the ref.
- For milestone-driven releases, `issues.list` with `milestone` filter
  returns the closed issues; cross-reference against commits to catch
  issues closed without a commit.
- If the repo uses `gh release create` in CI, the draft body should
  match what the workflow expects — read `.github/workflows/*release*`
  first.

## Confirmation boundary

- Reading tags, commits, milestones, prior releases: `read` tier,
  automatic.
- Producing the draft notes in chat: no tool call, just text.
- `releases.create`: `destructive` tier, strong explicit confirmation.
  This publishes a release visible to all watchers. Show the title and
  body one final time before submitting.
- `tags.delete` or `releases.delete`: `destructive` tier, strong
  confirmation. Rarely needed; do not offer unless the user asks.

## Pitfalls

- Conventional Commit titles can lie. A commit titled `feat:` that
  only renames a variable is not a feature — use judgment when
  classifying.
- Pre-release versions (`-beta.N`) need explicit `prerelease: true`
  on `releases.create`. Default to stable unless the user asked for a
  beta.
- Always cross-check `package.json` version (or equivalent) against
  the tag being created — Duya's release flow (AGENTS.md §Git)
  requires them to match in the same commit.
