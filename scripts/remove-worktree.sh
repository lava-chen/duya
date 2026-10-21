#!/usr/bin/env bash
# remove-worktree.sh — Safely remove a git worktree on Windows.
#
# WHY THIS EXISTS (incident 2026-08-25): GNU rm in Git Bash does not treat
# NTFS junctions as symlinks — `rm -rf <worktree>` recurses THROUGH them and
# destroys the junction targets' contents in the primary checkout
# (node_modules/@duya/* -> packages/* wiped 7 workspace packages). Always
# remove worktrees through this script: it unlinks every junction first
# (cmd rmdir WITHOUT /s removes the link only), then lets git remove the rest.
#
# Usage:
#   scripts/remove-worktree.sh <worktree-name-or-path> [--delete-branch]
#
# Examples:
#   scripts/remove-worktree.sh fix-automation-issues
#   scripts/remove-worktree.sh .claude/worktrees/win-path-fix --delete-branch

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: $0 <worktree-name-or-path> [--delete-branch]" >&2
  exit 2
fi

TARGET=$1
DELETE_BRANCH=${2:-}

# Resolve bare names against .claude/worktrees.
if [ ! -d "$TARGET" ] && [ -d ".claude/worktrees/$TARGET" ]; then
  TARGET=".claude/worktrees/$TARGET"
fi

if [ ! -d "$TARGET" ]; then
  echo "error: worktree directory not found: $TARGET" >&2
  exit 1
fi

# Never operate on the primary checkout itself.
REPO_ROOT=$(git rev-parse --show-toplevel)
TARGET_ABS_POSIX=$(cd "$TARGET" && pwd)
TARGET_ABS_WIN=$(cd "$TARGET" && pwd -W 2>/dev/null || echo "$TARGET_ABS_POSIX")
if [ "$REPO_ROOT" = "$TARGET_ABS_POSIX" ]; then
  echo "error: refusing to remove the primary checkout" >&2
  exit 1
fi

BRANCH=$(git -C "$TARGET" branch --show-current 2>/dev/null || true)

echo "==> worktree: $TARGET_ABS_POSIX (branch: ${BRANCH:-detached})"

# ---- Step 1: unlink every junction / symlink inside the worktree ----------
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
      echo "    WARN: failed to unlink (locked?): $j" >&2
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

# ---- Step 2: let git remove the worktree ---------------------------------
# NOTE: pass the POSIX/relative form to git and rm — a Windows backslash
# path from `pwd -W` is mangled by MSYS argument conversion and rm would
# silently no-op on it.
if git worktree remove --force "$TARGET" 2>/dev/null && [ ! -d "$TARGET" ]; then
  echo "==> removed via git worktree remove"
else
  # Fallback: junctions are gone, so a recursive delete is now safe.
  echo "==> falling back to direct delete"
  chmod -R u+w "$TARGET" 2>/dev/null || true
  rm -rf "$TARGET"
  git worktree prune
fi

# Verify the tree is really gone before touching the branch.
if [ -d "$TARGET" ]; then
  echo "error: worktree directory still exists (locked files?) — branch kept." >&2
  echo "resolve the lock and re-run this script." >&2
  exit 1
fi

# ---- Step 3: optional branch cleanup --------------------------------------
if [ "$DELETE_BRANCH" = "--delete-branch" ] && [ -n "$BRANCH" ]; then
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
