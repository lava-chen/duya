# Inspect the failed curation runs in the memory-state DB.
# Goal: confirm that every failed run predates the recent fixes
# (401 baseURL fix, Unknown mode: automation fix, pool 120s timeout fix)
# and that no run has failed AFTER those fixes were applied.
#
# Usage: pwsh -File scripts/inspect-curation-failures.ps1 [-Db <path>]
param(
  [string]$Db = "$env:APPDATA\DUYA\duya-dev\databases\memory-state.db"
)

if (-not (Test-Path $Db)) {
  Write-Error "memory-state DB not found at: $Db"
  exit 1
}

$now = Get-Date
Write-Host "== memory-state DB: $Db" -ForegroundColor Cyan
Write-Host "== now: $($now.ToString('yyyy-MM-dd HH:mm:ss'))" -ForegroundColor Cyan
Write-Host ""

# 1) Overall status counts
Write-Host "== curation_runs status counts ==" -ForegroundColor Cyan
sqlite3 $Db "SELECT status, COUNT(*) FROM curation_runs GROUP BY status;"
Write-Host ""

# 2) Failed runs: id, finished_at (local), publication_status, error category, full error
Write-Host "== ALL failed runs (id | finished_at | pub | category) ==" -ForegroundColor Cyan
sqlite3 $Db -separator ' | ' "SELECT substr(run_id,1,8), datetime(finished_at/1000,'unixepoch','localtime'), publication_status, CASE WHEN error LIKE '%invalid x-api-key%' THEN '401-invalid-key' WHEN error LIKE '%Unknown mode%' THEN 'unknown-mode' WHEN error LIKE '%Permission%' OR error LIKE '%ask%permission%' THEN 'permission-block' WHEN error LIKE '%timed out%' OR error LIKE '%killing%' THEN 'pool-timeout' WHEN error LIKE '%timeout%' THEN 'runner-timeout' ELSE 'other' END FROM curation_runs WHERE status='failed' ORDER BY finished_at;"
Write-Host ""

# 3) Category histogram
Write-Host "== error category histogram ==" -ForegroundColor Cyan
sqlite3 $Db "SELECT CASE WHEN error LIKE '%invalid x-api-key%' THEN '401-invalid-key' WHEN error LIKE '%Unknown mode%' THEN 'unknown-mode' WHEN error LIKE '%timed out%' OR error LIKE '%killing%' THEN 'pool-timeout' WHEN error LIKE '%timeout%' THEN 'runner-timeout' ELSE 'other' END AS cat, COUNT(*) FROM curation_runs WHERE status='failed' GROUP BY cat;"
Write-Host ""

# 4) Full error text of each failed run
Write-Host "== full error text per failed run ==" -ForegroundColor Cyan
sqlite3 $Db "SELECT '--- '||substr(run_id,1,8)||' @ '||datetime(finished_at/1000,'unixepoch','localtime')||char(10)||error||char(10) FROM curation_runs WHERE status='failed' ORDER BY finished_at;"
Write-Host ""

# 5) When did the most recent run (any status) happen? Tells us if anything ran after the fix.
Write-Host "== most recent started_at / finished_at across all runs ==" -ForegroundColor Cyan
sqlite3 $Db "SELECT 'max_started: '||datetime(MAX(started_at)/1000,'unixepoch','localtime') FROM curation_runs; SELECT 'max_finished: '||datetime(MAX(finished_at)/1000,'unixepoch','localtime') FROM curation_runs WHERE finished_at IS NOT NULL;"
Write-Host ""

# 6) Timestamp of the code fix reference: list git log for the 3 fix files (best-effort)
Write-Host "== git log (uncommitted vs committed) for fix files ==" -ForegroundColor Cyan
$files = @(
  "electron/memory/curation_agent_runner.ts",
  "packages/agent/src/modes/index.ts",
  "packages/agent/src/modes/automation-mode.ts",
  "electron/agents/process-pool/agent-process-pool.ts",
  "electron/agents/process-pool/process-manager.ts"
)
foreach ($f in $files) {
  $last = git log -1 --format="%h %ci %s" -- $f 2>$null
  Write-Host ("{0,-58} {1}" -f $f, $last)
}
Write-Host ""

Write-Host "== NOTE: uncommitted working-tree edits (the fixes) won't appear in git log; use file mtimes below ==" -ForegroundColor Cyan
foreach ($f in $files) {
  $p = Join-Path (Resolve-Path e:\Projects\duya) $f
  if (Test-Path $p) {
    $m = (Get-Item $p).LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss')
    Write-Host ("{0,-58} mtime={1}" -f $f, $m)
  }
}
