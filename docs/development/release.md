# Release Tag

`package.json` `version` is the **source of truth** for the released artifact.
`electron-builder` reads the version from `package.json`, not from the git tag.
If `package.json:version` still points to a previously-released version,
`electron-builder --publish always` will skip creating the new release and exit 0
(silent no-op).

- **MUST bump `package.json` `version` in the same commit as the release tag.**
- Pre-tag checklist:
  1. Pick the next version (see [How to recommend a tag](#how-to-recommend-a-tag) below).
  2. Update `package.json` `version` (e.g. `0.1.3-beta.2` → `0.1.3-beta.3`).
  3. Commit the bump before tagging (`chore(release): bump version to <X>`).
  4. Tag the bump commit, not an earlier one.
  5. `git push origin <branch>` then `git push origin v<X>`.
  6. The CI release workflow is the only thing that should ever create a GitHub Release.
- If a tag is pushed without the corresponding `package.json` bump, the release will fail
  silently (workflow job shows `success`, but no Release is created on GitHub). Always verify
  the Release exists with `gh release view <tag>` after a release run.

## How to recommend a tag

When the user asks "what tag should I cut?" (or "打 tag 时根据规则自己推荐一个最合适的 tag"),
follow this procedure. Do not silently pick a number — always **show the recommendation,
the reasoning, and any detected breaking changes, and ask the user to confirm before tagging**.

1. **Collect the candidate set.**
   - `git tag --list 'v*' --sort=-v:refname | head -5` — most recent tags.
   - `git log <last-tag>..HEAD --oneline` — commits since the last tag.
   - `cat package.json | grep '"version"'` — current declared version.
   - The current `package.json` `version` is the **floor**: the next tag must be `>=` it.

2. **Classify every commit** since the last tag with the highest applicable
   Conventional-Commit type:
   - `BREAKING CHANGE:` footer or `!` after type/scope → **MAJOR**
   - `feat:` → **MINOR**
   - `fix:`, `refactor:`, `perf:`, `docs:`, `test:`, `build:`, `ci:`, `chore:` → **PATCH**
   - `revert:` is treated as the type of the reverted commit.

3. **Apply semver, project-specific overrides below**, then pick the highest.

4. **Recommend** the version, the bump type, and one-line evidence
   (e.g. *"3 `feat:`, 12 `fix:`, 0 `BREAKING CHANGE`. Recommend `0.1.5` (MINOR)."*).
   Wait for user confirmation before tagging.

### Semver rules for duya

`0.x` is pre-1.0, so MAJOR bumps are not yet meaningful — use MINOR to signal
"anything beyond fixes." This matches the existing trajectory
(`0.1.1` → `0.1.2` → `0.1.3-beta.*` → `0.1.4`).

| Highest commit type | Current `0.x` | Next tag (default) |
| ------------------- | ------------- | ------------------- |
| `BREAKING CHANGE`   | `0.1.x`       | bump MINOR (e.g. `0.1.4` → `0.2.0`) |
| `feat`              | `0.1.x`       | bump MINOR (e.g. `0.1.4` → `0.1.5`) |
| `fix` / others      | `0.1.x`       | PATCH and MINOR are the same shape below `1.0` — a fix-only line still bumps the minor counter (`0.1.4` → `0.1.5`) |
| anything            | `1.x.y`       | standard semver (MAJOR/MINOR/PATCH as above) |

**Pre-release (`-beta.N`) decision** — default to a stable release, not a beta, unless
any of the following are true:

- The user asked for a beta explicitly.
- The last shipped tag was itself a beta and the packaged build has not yet been smoke-tested.
- A `feat:` landed that touches the packaging / install path (`electron:pack`,
  `electron-builder`, `electron:build`) and a packaged smoke test is still pending.
- A `BREAKING CHANGE` landed against a public CLI / IPC surface and we want early adopters
  to test before promoting to stable.

If any of the above, recommend e.g. `0.1.5-beta.1` (increment `.N` from the most recent
`-beta.M` on the same MINOR line; reset `.N` to `1` when MINOR advances).

### Confirmation template

Show the user this block and wait for `ok` / a different number:

```
Recommended tag:  v0.1.5
  - reason:      3 feat(agent/electron/cli), 12 fix/refactor, 0 BREAKING
  - current:     0.1.4  (package.json)
  - last tag:    v0.1.4 (2026-06-09, 41 commits ago)
  - pre-release: no — packaged smoke not pending, no beta requested

Confirm to:  1) bump package.json → 0.1.5
             2) chore(release) commit
             3) git tag -a v0.1.5 -F docs/release-notes/v0.1.5.md
             4) push branch + tag
```

### Tag message

Annotated tag, body from `docs/release-notes/v<X>.md` (one bullet per headline change,
no prose). Example:

```bash
git tag -a v0.1.5 -F docs/release-notes/v0.1.5.md
git push origin master v0.1.5
```

The release-notes file is the only place where the changelog lives in long form.
Do not duplicate it into the tag body.

### Execution workflow

After the user confirms the recommendation, run these steps in order:

1. Make sure `docs/release-notes/v<X>.md` exists. Create it from the headline changelog
   bullets if it does not.
2. Bump `package.json` `version` to `<X>`.
3. Stage and commit the bump and the release notes:
   ```bash
   git add package.json docs/release-notes/v<X>.md
   git commit -m "chore(release): bump version to <X>"
   ```
4. Create an annotated tag using the release notes as the tag body:
   ```bash
   git tag -a v<X> -F docs/release-notes/v<X>.md
   ```
5. Push the branch and the tag together to trigger the release workflow:
   ```bash
   git push origin <branch> v<X>
   ```
6. Verify the push succeeded:
   ```bash
   git branch -vv
   git ls-remote --tags origin refs/tags/v<X>
   ```
7. Check the repository Actions page to confirm the release workflow started and monitor
   it to completion.

If a previous attempt partially completed (commit exists but tag/push failed), inspect the
current state first to avoid duplicates:

```bash
git status
git log --oneline -3
git tag --list 'v<X>*'
git ls-remote --tags origin refs/tags/v<X>
```
