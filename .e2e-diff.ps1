$ErrorActionPreference = 'Stop'

function Get-FailedE2E([string]$runId) {
  $j = gh api "repos/lava-chen/duya/actions/runs/$runId/jobs" | ConvertFrom-Json
  $build = $j.jobs | Where-Object { $_.name -like 'build*' } | Select-Object -First 1
  if (-not $build) { Write-Host "no build job in $runId"; return @() }
  $raw = gh api "repos/lava-chen/duya/actions/jobs/$($build.id)/logs" 2>&1 | Out-String
  $lines = $raw -split "`n"
  $idx = -1
  for ($i = 0; $i -lt $lines.Count; $i++) {
    $c = ($lines[$i] -replace '\x1b\[[0-9;]*m','')
    if ($c -match '^\S+Z\s+\d+ failed\s*$') { $idx = $i; break }
  }
  if ($idx -lt 0) { Write-Host "no anchor in $runId"; return @() }
  $out = New-Object System.Collections.ArrayList
  for ($i = $idx + 1; $i -lt $lines.Count; $i++) {
    $c = ($lines[$i] -replace '\x1b\[[0-9;]*m','').Trim()
    if ($c -match '^\S+Z\s+\d+ (did not run|passed|skipped|interrupted|flaky)') { break }
    if ($c -match 'e2e/[\w/\-.]+\.spec\.ts') {
      if ($c -match '(e2e/[\w/\-.]+\.spec\.ts)') { [void]$out.Add($Matches[1]) }
    }
  }
  return @($out | Sort-Object -Unique)
}

$base = $args[0]
$target = $args[1]
$b = Get-FailedE2E $base
$t = Get-FailedE2E $target
Write-Host "base $base : $($b.Count) failed specs"
$b | ForEach-Object { Write-Host "   $_" }
Write-Host "target $target : $($t.Count) failed specs"
$t | ForEach-Object { Write-Host "   $_" }
$new = @($t | Where-Object { $b -notcontains $_ })
$gone = @($b | Where-Object { $t -notcontains $_ })
Write-Host ""
Write-Host "=== NEW in target (regressions) = $($new.Count) ==="
$new | ForEach-Object { Write-Host "   $_" }
Write-Host "=== only in base (fixed/absent) = $($gone.Count) ==="
$gone | ForEach-Object { Write-Host "   $_" }
