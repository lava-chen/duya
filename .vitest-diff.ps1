param()
$ErrorActionPreference = 'Stop'

function Get-FailedTestFiles([string]$runId) {
  $j = gh api "repos/lava-chen/duya/actions/runs/$runId/jobs" | ConvertFrom-Json
  $t = $j.jobs | Where-Object { $_.name -like 'test (*' } | Select-Object -First 1
  if (-not $t) { Write-Host "no test job in $runId"; return @() }
  $raw = gh api "repos/lava-chen/duya/actions/jobs/$($t.id)/logs" 2>&1 | Out-String
  $lines = $raw -split "`n"
  $set = New-Object System.Collections.Generic.HashSet[string]
  foreach ($l in $lines) {
    $c = ($l -replace '\x1b\[[0-9;]*m','')
    # " FAIL  path/to/file.test.ts > suite > case"
    if ($c -match '^\S+Z\s+FAIL\s+(\S+\.(?:test|spec)\.[tj]sx?)') {
      [void]$set.Add($Matches[1])
      continue
    }
    # " FAIL  path/to/file.test.ts [ path/to/file.test.ts ]"  (collection error)
    if ($c -match '^\S+Z\s+FAIL\s+(\S+\.(?:test|spec)\.[tj]sx?)\s*\[') {
      [void]$set.Add($Matches[1])
    }
  }
  return $set
}

$base = $args[0]
$target = $args[1]
$b = Get-FailedTestFiles $base
$t = Get-FailedTestFiles $target
Write-Host "base $base : $($b.Count) failed test files"
Write-Host "target $target : $($t.Count) failed test files"
$new = @($t | Where-Object { -not $b.Contains($_) } | Sort-Object)
$gone = @($b | Where-Object { -not $t.Contains($_) } | Sort-Object)
Write-Host ""
Write-Host "=== NEW failures in target (introduced) = $($new.Count) ==="
$new | ForEach-Object { Write-Host "  $_" }
Write-Host "=== only in base (not in target) = $($gone.Count) ==="
$gone | ForEach-Object { Write-Host "  $_" }
