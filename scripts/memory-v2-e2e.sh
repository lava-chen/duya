#!/usr/bin/env bash
# Memory v2 e2e manual run script (Plan 305 Phase D/E).
#
# Usage:
#   scripts/memory-v2-e2e.sh
#
# Prerequisites:
#   - duya built with DUYA_MEMORY_V2_ENABLED=1
#   - sqlite3 on PATH
#
# This script runs only manually, not in CI. It wipes memory v2 state,
# starts duya, waits for at least one worker tick, then asserts files
# and DB state.
set -euo pipefail

export DUYA_MEMORY_V2_ENABLED=1
export DUYA_MEMORY_TEST_FAST=1   # skip the 6h idle wait

# Memory DB sits next to duya-main.db, resolved via boot.json with the
# same helper the app uses (electron/config/boot-config.ts#getDatabasePath).
# NEVER hard-code the abandoned v2-draft path ~/.duya/memory/memory-state.db.
MEM_DB="$(node -e "
  const path = require('path');
  const { getDatabasePath } = require('./electron/config/boot-config');
  console.log(path.join(path.dirname(getDatabasePath()), 'memory-state.db'));
")"

echo "Memory DB path: $MEM_DB"

# 1. Wipe state
echo "Wiping memory v2 state..."
rm -f "$MEM_DB"
rm -rf ~/.duya/memory/global ~/.duya/memory/projects \
       ~/.duya/memory/rollout_summaries ~/.duya/memory/raw_memories.md

# 2. Start duya, run a 30-min session in E:\Projects\duya
echo ""
echo "=== Starting duya with Memory v2 enabled ==="
echo "Run a real session for >= 30 minutes, then end the session."
echo "The worker will pick up the rollout after the idle period (or"
echo "immediately if DUYA_MEMORY_TEST_FAST=1 is respected)."
echo ""

# 3. Wait for worker to complete at least one tick
echo "Waiting for worker tick (up to 120s)..."
for i in $(seq 1 120); do
  if [ -d ~/.duya/memory/rollout_summaries ] && \
     [ "$(ls ~/.duya/memory/rollout_summaries/ 2>/dev/null | wc -l)" -ge 1 ]; then
    echo "Worker tick completed after ${i}s"
    break
  fi
  sleep 1
done

# 4. Assert files & DB state
echo ""
echo "=== Assertions ==="

# rollout_summaries should have >= 1 file
SUMMARY_COUNT=$(ls ~/.duya/memory/rollout_summaries/ 2>/dev/null | wc -l)
echo "rollout_summaries count: $SUMMARY_COUNT (expect >= 1)"
if [ "$SUMMARY_COUNT" -lt 1 ]; then
  echo "FAIL: no rollout summaries written"
  exit 1
fi

# raw_memories.md should exist
if [ ! -f ~/.duya/memory/raw_memories.md ]; then
  echo "FAIL: raw_memories.md does not exist"
  exit 1
fi
echo "raw_memories.md: exists"

# global/summary.md must NOT exist (shadow mode)
if [ -f ~/.duya/memory/global/summary.md ]; then
  echo "FAIL: global/summary.md exists (shadow-mode violation)"
  exit 1
fi
echo "global/summary.md: absent (shadow mode OK)"

# DB state
echo ""
echo "=== stage1_outputs ==="
sqlite3 "$MEM_DB" \
  "SELECT rollout_id, job_status, content_outcome FROM stage1_outputs" | head

echo ""
echo "=== All assertions passed ==="
