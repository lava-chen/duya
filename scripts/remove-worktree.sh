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
#   - discard uncommitted work (dirty worktrees are refused; --force preserves
#     the work as a patch + untracked tarball first)
#   - remove a worktree git has marked locked (an active session holds it)
#   - follow a junction/reparse point (links are unlinked first and the tree is
#     re-scanned; any survivor aborts the run)
#
# There is deliberately no `rm -rf` fallback. `git worktree remove` is the
# only thing that deletes the tree, and it refuses exactly the states we want
# to refuse (dirty / locked / submodule).
#
# Usage:
#   scripts/remove-worktree.sh <worktree-name-or-path> [--delete-branch] [--force] [--dry-run]
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
FORCE=0
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --delete-branch) DELETE_BRANCH=1 ;;
    --force) FORCE=1 ;;
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
  if [ "$FORCE" != "1" ]; then
    echo "error: $TARGET has uncommitted changes:" >&2
    echo "$STATUS" | sed 's/^/    /' >&2
    echo "commit or stash them first, or re-run with --force to preserve them under" >&2
    echo ".claude/worktree-snapshots/ before removal." >&2
    exit 1
  fi
fi

echo "==> worktree: $TARGET_ABS (branch: ${BRANCH:-detached})"

if [ "$DRY_RUN" = "1" ]; then
  echo "==> [dry-run] identity, lock and cleanliness checks passed"
  if [ -n "$STATUS" ]; then
    echo "==> [dry-run] would preserve uncommitted work, then remove the worktree"
  else
    echo "==> [dry-run] would remove the worktree (clean)"
  fi
  [ "$DELETE_BRANCH" = "1" ] && echo "==> [dry-run] would delete branch $BRANCH if it is merged"
  exit 0
fi

# ---- Step 1: preserve uncommitted work (only reachable via --force) ------
if [ -n "$STATUS" ]; then
  SNAP_DIR="$REPO_ROOT/.claude/worktree-snapshots/$(basename "$TARGET_ABS")-$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$SNAP_DIR"
  git -C "$TARGET" diff HEAD --binary > "$SNAP_DIR/worktree.patch"
  git -C "$TARGET" ls-files --others --exclude-standard -z > "$SNAP_DIR/untracked.list"
  if [ -s "$SNAP_DIR/untracked.list" ]; then
    tar -czf "$SNAP_DIR/untracked.tgz" -C "$TARGET_ABS" --null -T "$SNAP_DIR/untracked.list"
  fi
  echo "==> preserved uncommitted work in: $SNAP_DIR"
fi

# ---- Step 2: unlink every junction / symlink inside the worktree ----------
# `cmd dir /a:l` lists reparse points (Windows paths); `rmdir` WITHOUT /s
# removes the link itself and never touches the target. This must happen
# before any recursive delete touches the tree.
echo "==> unlinking junctions/symlinks"
JUNCTIONS=$(cd "$TARGET" && cmd //c "dir /s /b /a:l" 2>/dev/null || true)
UNLINKED=0
if [ -n "$JUNCTIONS" ]; then
  while IFS= read -r j; do
    [ -n "$j" ] || continue
    # j is a Windows path (backslashes) — hand it straight back to cmd.
    if cmd //c rmdir "\\\\?\\""$j" >/dev/null 2>&1; then
      echo "    unlinked: $j"
      UNLINKED=$((UNLINKED + 1))
    else
      # Fail-closed: a link we could not unlink is a link a recursive delete
      # would follow. Stop before touching anything else.
      fail "could not unlink (locked?): $j — nothing was removed"
    fi
  done <<< "$JUNCTIONS"
fi
echo "    unlinked $UNLINKED junction(s)"

# Re-scan: if any reparse point remains, ABORT — a recursive delete now
# would follow it into the primary checkout.
LEFTOVER=$(cd "$TARGET" && cmd //c "dir /s /b /a:l" 2>/dev/null || true)
if [ -n "$LEFTOVER" ]; then
  echo "error: junctions remain after unlink attempt — NOT deleting:" >&2
  echo "$LEFTOVER" >&2
  echo "close whatever holds them locked and retry." >&2
  exit 1
fi

# ---- Step 3: let git remove the worktree ---------------------------------
# NOTE: pass the POSIX/relative form to git — a Windows backslash path from
# `pwd -W` is mangled by MSYS argument conversion.
if git worktree remove "$TARGET" 2>/dev/null; then
  echo "==> removed via git worktree remove"
elif [ "$FORCE" = "1" ]; then
  git worktree remove --force "$TARGET" \
    || fail "git could not remove $TARGET (locked files?) — nothing else was touched"
  echo "==> removed via git worktree remove --force"
else
  fail "git refused to remove $TARGET (modified files, submodules, or a locked worktree). Nothing was deleted. Re-run with --force after preserving your work."
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
