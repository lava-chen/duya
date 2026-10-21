#!/usr/bin/env bash
# remove-worktree.sh — fail-closed removal of a git worktree on Windows.
#
# WHY THIS EXISTS (incident 2026-08-25 and again 2026-10-03): GNU rm in
# Git Bash does not treat NTFS junctions as symlinks — `rm -rf <worktree>`
# recurses THROUGH them and destroys the junction targets' contents in the
# primary checkout (node_modules/@duya/* -> packages/* wiped every workspace
# package). 3,471 tracked files on 2026-08-25, 3,492 more on 2026-10-03.
#
# THIS SCRIPT IS FAIL-CLOSED. Every precondition is verified BEFORE anything
# is mutated; if any check cannot be satisfied the script aborts and changes
# nothing at all. In particular it will never:
#   - remove a directory that is not a registered linked worktree of THIS repo
#   - discard uncommitted work (dirty worktrees are always refused; --force
#     is not supported)
#   - remove a worktree git has marked locked (an active session holds it)
#   - follow a junction/reparse point (links are unlinked first and the tree is
#     re-scanned; any survivor aborts the run)
#
# There is deliberately no `rm -rf` fallback. `git worktree remove` is the
# only thing that deletes the tree, and it refuses exactly the states we want
# to refuse (dirty / locked / submodule).
#
# Usage:
#   scripts/remove-worktree.sh <worktree-name-or-path> [--delete-branch] [--dry-run]
#
# Examples:
#   scripts/remove-worktree.sh fix-automation-issues
#   scripts/remove-worktree.sh .claude/worktrees/win-path-fix --delete-branch
#   scripts/remove-worktree.sh .claude/worktrees/win-path-fix --dry-run

set -euo pipefail

usage() {
  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
}

fail() {
  echo "error: $*" >&2
  exit 1
}

TARGET=""
DELETE_BRANCH=0
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --delete-branch) DELETE_BRANCH=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "error: unknown option: $arg" >&2; usage >&2; exit 2 ;;
    *)
      if [ -n "$TARGET" ]; then
        echo "error: expected exactly one worktree, got: $arg" >&2
        exit 2
      fi
      TARGET="$arg"
      ;;
  esac
done

if [ -z "$TARGET" ]; then
  usage >&2
  exit 2
fi

# Resolve bare names against .claude/worktrees.
if [ ! -d "$TARGET" ] && [ -d ".claude/worktrees/$TARGET" ]; then
  TARGET=".claude/worktrees/$TARGET"
fi

[ -d "$TARGET" ] || fail "worktree directory not found: $TARGET"

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || fail "not inside a git repository"
TARGET_ABS=$(cd "$TARGET" && pwd -P)
# `git worktree list` prints Windows paths ("C:/repo/.claude/worktrees/x"),
# while the shell's own `pwd -P` prints an MSYS path ("/c/repo/..."). Comparing
# the two directly never matches, so compare the WINDOWS form of both.
TARGET_ABS_WIN=$(cd "$TARGET" && pwd -W 2>/dev/null || echo "$TARGET_ABS")
CWD_ABS_WIN=$(pwd -W 2>/dev/null || pwd -P)

# Normalize for comparison: separators, case and a trailing slash are all
# irrelevant to "is this the same directory".
norm() {
  printf '%s' "$1" | tr '\\' '/' | tr '[:upper:]' '[:lower:]' | sed 's#/*$##'
}

REPO_NORM=$(norm "$REPO_ROOT")
TARGET_NORM=$(norm "$TARGET_ABS_WIN")

# ---- Check 1: never the primary checkout, never the caller's cwd ----------
if [ "$TARGET_NORM" = "$REPO_NORM" ]; then
  fail "refusing to remove the primary checkout ($REPO_ROOT)"
fi
if [ "$TARGET_NORM" = "$(norm "$CWD_ABS_WIN")" ]; then
  fail "refusing to remove the current working directory — cd out of it first"
fi

# ---- Check 2: identity — must be a REGISTERED linked worktree -------------
# Without this, a mistyped path (say packages/agent) would fall through to the
# delete path and take the source tree with it. Registration is the only
# property that proves the directory is a git worktree and not something else.
[ -f "$TARGET/.git" ] || fail "refusing to remove $TARGET: not a linked git worktree (no .git file)"

REGISTERED=0
LOCKED=0
CURRENT=""
while IFS= read -r line; do
  case "$line" in
    "worktree "*) CURRENT="${line#worktree }" ;;
    "locked"*)
      if [ "$(norm "$CURRENT")" = "$TARGET_NORM" ]; then LOCKED=1; fi
      ;;
  esac
  if [ -n "$CURRENT" ] && [ "$(norm "$CURRENT")" = "$TARGET_NORM" ]; then
    REGISTERED=1
  fi
done <<< "$(git worktree list --porcelain)"

[ "$REGISTERED" = "1" ] || fail "refusing to remove $TARGET: not a registered worktree of $REPO_ROOT"

# ---- Check 3: locked worktrees belong to an active session ----------------
[ "$LOCKED" = "0" ] || fail "refusing to remove $TARGET: git has it locked (an active session holds it) — unlock it first"

BRANCH=$(git -C "$TARGET" branch --show-current 2>/dev/null || true)

# ---- Check 4: uncommitted work must not be discarded ----------------------
STATUS=$(git -C "$TARGET" status --porcelain 2>/dev/null) || fail "could not read git status of $TARGET"
if [ -n "$STATUS" ]; then
  echo "error: $TARGET has uncommitted changes:" >&2
  echo "$STATUS" | sed 's/^/    /' >&2
  echo "commit or stash them before removal." >&2
  exit 1
fi

# A detached worktree may be the only remaining reference to its HEAD. Git
# permits removing it, but doing so would silently discard an unmerged commit.
# Keep it until the caller creates an explicit backup branch or tag.
if [ -z "$BRANCH" ]; then
  DETACHED_REFS=$(git -C "$TARGET" for-each-ref --contains=HEAD \
    --format='%(refname)' refs/heads refs/remotes refs/tags 2>/dev/null) \
    || fail "could not check refs containing detached HEAD in $TARGET; worktree retained"
  [ -n "$DETACHED_REFS" ] || fail "detached HEAD is not contained in any branch, remote, or tag ref; create a backup ref before removal"
fi
echo "==> worktree: $TARGET_ABS (branch: ${BRANCH:-detached})"

if [ "$DRY_RUN" = "1" ]; then
  echo "==> [dry-run] identity, lock and cleanliness checks passed"
  echo "==> [dry-run] would remove the worktree (clean)"
  [ "$DELETE_BRANCH" = "1" ] && echo "==> [dry-run] would delete branch $BRANCH if it is merged"
  exit 0
fi

# ---- Step 2: unlink every junction / symlink inside the worktree ----------
# PowerShell enumerates reparse points without following them; rmdir without /s
# removes each reported link itself and never touches its target.
is_windows() {
  # `$OS` is set to `Windows_NT` by MSYS (Git Bash), but a NATIVE Linux or
  # macOS bash does not set it at all — and under `set -u` an unset variable
  # aborts the shell. Referencing it bare made this script die on every
  # non-Windows runner, which is where CI runs it. `${OS:-}` is the same
  # check with an unset value treated as "not Windows_NT".
  case "${OS:-}" in
    Windows_NT) return 0 ;;
  esac
  # `$OSTYPE` is set by bash itself in every mode.
  case "${OSTYPE:-}" in
    msys*|mingw*|cygwin*) return 0 ;;
  esac
  return 1
}

scan_reparse_points() {
  local output
  if is_windows; then
    if ! command -v powershell.exe >/dev/null 2>&1; then
      echo "error: PowerShell is required to scan Windows reparse points; worktree retained" >&2
      return 1
    fi
    if ! output=$(DUYA_REPARSE_SCAN_ROOT="$TARGET_ABS_WIN" powershell.exe -NoProfile -NonInteractive -Command '
      $ErrorActionPreference = "Stop"
      [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
      try {
        $root = [System.IO.Path]::GetFullPath($env:DUYA_REPARSE_SCAN_ROOT)
        $pending = [System.Collections.Generic.Stack[string]]::new()
        $pending.Push($root)
        while ($pending.Count -gt 0) {
          $current = $pending.Pop()
          foreach ($entry in (Get-ChildItem -LiteralPath $current -Force -ErrorAction Stop)) {
            if ($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
              [Console]::Out.WriteLine($entry.FullName)
            } elseif ($entry.PSIsContainer) {
              $pending.Push($entry.FullName)
            }
          }
        }
        exit 0
      } catch {
        [Console]::Error.WriteLine($_.Exception.Message)
        exit 1
      }
    ' 2>&1); then
      [ -n "$output" ] && echo "$output" >&2
      return 1
    fi
  else
    # find does not follow symlinks unless explicitly asked to do so.
    if ! output=$(find "$TARGET" -type l -print 2>&1); then
      [ -n "$output" ] && echo "$output" >&2
      return 1
    fi
  fi
  printf '%s' "$output"
}

echo "==> unlinking junctions/symlinks"
JUNCTIONS=$(scan_reparse_points) || fail "could not scan reparse points under $TARGET; worktree retained"
UNLINKED=0
if [ -n "$JUNCTIONS" ]; then
  while IFS= read -r j; do
    j=$(printf '%s' "$j" | tr -d '\r')
    [ -n "$j" ] || continue
    JUNCTION_NORM=$(norm "$j")
    case "/$JUNCTION_NORM/" in
      *"/../"*|*"/./"*) fail "scanner returned a non-canonical path; worktree retained: $j" ;;
    esac
    case "$JUNCTION_NORM" in
      "$TARGET_NORM"/*) ;;
      *) fail "scanner returned a path outside the worktree; worktree retained: $j" ;;
    esac
    # j is a Windows absolute path — hand it straight back to cmd.
    if cmd //c rmdir "\\\\?\\""$j" >/dev/null 2>&1; then
      echo "    unlinked: $j"
      UNLINKED=$((UNLINKED + 1))
    else
      # Fail-closed: a link we could not unlink is a link a recursive delete
      # would follow. Stop before touching anything else.
      fail "could not unlink (locked?): $j — worktree retained; some links may already be unlinked"
    fi
  done <<< "$JUNCTIONS"
fi
echo "    unlinked $UNLINKED junction(s)"

# Re-scan: if any reparse point remains, ABORT before asking Git to remove the
# worktree. A failed scan is different from a successful scan with no results.
LEFTOVER=$(scan_reparse_points) || fail "could not verify reparse-point removal under $TARGET; worktree retained"
if [ -n "$LEFTOVER" ]; then
  echo "error: junctions remain after unlink attempt — worktree retained:" >&2
  echo "$LEFTOVER" >&2
  echo "close whatever holds them locked and retry." >&2
  exit 1
fi

# ---- Step 3: let git remove the worktree ---------------------------------
# NOTE: pass the POSIX/relative form to git — a Windows backslash path from
# `pwd -W` is mangled by MSYS argument conversion.
if git worktree remove "$TARGET" 2>/dev/null; then
  echo "==> removed via git worktree remove"
else
  fail "git refused to remove $TARGET (modified files, submodules, or a locked worktree). worktree retained."
fi

git worktree prune

# Verify the tree is really gone before touching the branch.
if [ -d "$TARGET" ]; then
  echo "error: worktree directory still exists (locked files?) — branch kept." >&2
  echo "resolve the lock and re-run this script." >&2
  exit 1
fi

# ---- Step 4: optional branch cleanup --------------------------------------
if [ "$DELETE_BRANCH" = "1" ] && [ -n "$BRANCH" ]; then
  if git merge-base --is-ancestor "$BRANCH" origin/master 2>/dev/null \
    || git merge-base --is-ancestor "$BRANCH" master 2>/dev/null; then
    git branch -d "$BRANCH" && echo "==> deleted merged branch $BRANCH"
  else
    echo "==> branch $BRANCH has unmerged commits — kept (use: git branch -D $BRANCH)"
  fi
else
  [ -n "$BRANCH" ] && echo "==> branch kept: $BRANCH"
fi

echo "==> done"
