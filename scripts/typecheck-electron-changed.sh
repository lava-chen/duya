#!/usr/bin/env bash
# scripts/typecheck-electron-changed.sh
#
# Narrow typecheck gate for the `electron/` project (Plan 107).
#
# Background:
#   `npm run typecheck:all` does not run `tsc` against
#   `electron/tsconfig.json` today — there are ~311 pre-existing
#   errors that need a separate cleanup plan (108). This script is
#   a per-change gate: it runs the full electron tsc, then filters
#   the output to only the files changed in the last commit, and
#   then strips out known pre-existing error patterns. Exit code 0
#   means "no NEW errors in the changed files".
#
# Wire into package.json / pre-commit AFTER Plan 108 cleans the
# remaining 311 errors; until then this is a manual diagnostic.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Collect changed .ts files in the electron/ tree from the last commit.
# Falls back to the working tree diff if HEAD~1 does not exist (e.g.
# shallow clone, brand-new repo).
if git rev-parse HEAD~1 >/dev/null 2>&1; then
  CHANGED=$(git diff --name-only HEAD~1 -- 'electron/**/*.ts' | tr '\n' ' ')
else
  CHANGED=$(git diff --name-only -- 'electron/**/*.ts' | tr '\n' ' ')
fi

# Trim trailing whitespace
CHANGED="${CHANGED% }"

if [ -z "$CHANGED" ]; then
  echo "[typecheck-electron-changed] No changed files in electron/**/*.ts — skipping."
  exit 0
fi

echo "[typecheck-electron-changed] Changed files:"
for f in $CHANGED; do echo "  - $f"; done

# Run tsc against the full project, then filter to changed files only,
# then strip pre-existing patterns. If rg is not available, fall back
# to grep -F.
TSC_OUT=$(npx tsc --noEmit -p electron/tsconfig.json 2>&1 || true)

# rg is available on most dev machines; fall back to grep if not.
if command -v rg >/dev/null 2>&1; then
  FILTERED=$(echo "$TSC_OUT" | rg -F "$CHANGED" | rg -v 'plugin-error|rootDir|Statement<unknown' || true)
else
  FILTERED=$(echo "$TSC_OUT" | grep -F "$CHANGED" | grep -vE 'plugin-error|rootDir|Statement<unknown' || true)
fi

if [ -n "$FILTERED" ]; then
  echo "[typecheck-electron-changed] NEW errors in changed files:"
  echo "$FILTERED"
  exit 1
fi

echo "[typecheck-electron-changed] OK — no new errors in changed files."
exit 0
