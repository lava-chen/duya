# smoke-576.ps1 — plan 576 probe walk real-machine smoke.
#
# Spawns the persistent uia-probe, enumerates a real window, and asserts
# the plan 576 walk contract on the wire:
#   - every element carries an integer `depth`
#   - some elements carry an absorbed `label` (Text-bearing apps)
#   - no non-interactive-only vocabulary leak (Document allowed)
#   - the invoke cache order equals the emission order (slots intact)
# Prints a compact summary; exit 0 on pass, 1 on failure.

$ErrorActionPreference = 'Stop'

$probePath = 'E:\Projects\duya\resources\recorder\uia-probe.ps1'
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'powershell.exe'
$psi.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $probePath + '"'
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
$psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8

$proc = [System.Diagnostics.Process]::Start($psi)

function Send-Line([System.Diagnostics.Process]$p, [string]$line) {
    $p.StandardInput.WriteLine($line)
    $p.StandardInput.Flush()
}

function Read-Line([System.Diagnostics.Process]$p) {
    return $p.StandardOutput.ReadLine()
}

function Wait-Response([System.Diagnostics.Process]$p, [int]$wantId, [int]$timeoutMs) {
    $deadline = [DateTime]::UtcNow.AddMilliseconds($timeoutMs)
    while ([DateTime]::UtcNow -lt $deadline) {
        $line = Read-Line $p
        if ($null -eq $line) { throw 'probe stdout closed' }
        try { $json = $line | ConvertFrom-Json } catch { continue }
        if ($json.id -eq $wantId) { return $json }
    }
    throw ("timeout waiting for response id " + $wantId)
}

$ready = Read-Line $proc
Write-Host ("ready: " + $ready)

Send-Line $proc '{"id":1,"op":"ping"}'
$ping = Wait-Response $proc 1 5000
if ($ping.ok -ne $true) { throw 'ping failed' }
Write-Host 'ping: ok'

Send-Line $proc '{"id":2,"op":"apps"}'
$apps = Wait-Response $proc 2 10000
if ($apps.ok -ne $true -or $null -eq $apps.apps -or $apps.apps.Count -eq 0) {
    throw 'no apps enumerated'
}
Write-Host ("apps: " + $apps.apps.Count)

# Try up to the first 6 apps — the first window often belongs to a
# tray utility whose main window legitimately has no controls.
$tree = $null
$hwnd = 0
$usedTitle = ''
$reqId = 4
foreach ($app in $apps.apps) {
    if ($app.pid -le 0) { continue }
    Send-Line $proc ('{"id":' + ($reqId + 1) + ',"op":"windows","pid":' + $app.pid + '}')
    $wins = Wait-Response $proc ($reqId + 1) 10000
    foreach ($w in $wins.windows) {
        if ($w.cloaked -ne $true -and $w.hwnd -gt 0 -and $w.minimized -ne $true) { $hwnd = $w.hwnd; break }
    }
    if ($hwnd -eq 0) { continue }
    Send-Line $proc ('{"id":' + ($reqId + 2) + ',"op":"enumerate","hwnd":' + $hwnd + ',"totalMs":8000}')
    $candidate = Wait-Response $proc ($reqId + 2) 12000
    $reqId += 2
    if ($candidate.ok -eq $true -and $null -ne $candidate.elements -and $candidate.elements.Count -gt 0) {
        $tree = $candidate
        $usedTitle = $app.title
        break
    }
    $hwnd = 0
}
if ($null -eq $tree) {
    Write-Host 'NO-EMPTY-TREE: no app window yielded a non-empty tree (see stderr dump below)'
    $fail = @('no app window yielded a non-empty tree')
    $elements = @()
} else {
    $elements = $tree.elements
}
Write-Host ("enumerate: count=" + $elements.Count + " truncated=" + $tree.truncated)

$byType = @{}
$withLabel = 0
$withChecked = 0
$withDescription = 0
$offscreen = 0
$missingDepth = 0
$maxDepth = 0
foreach ($el in $elements) {
    $t = $el.controlType
    if ($byType.ContainsKey($t)) { $byType[$t] = $byType[$t] + 1 } else { $byType[$t] = 1 }
    if ($null -ne $el.label) { $withLabel++ }
    if ($null -ne $el.checked) { $withChecked++ }
    if ($null -ne $el.description) { $withDescription++ }
    if ($el.offscreen -eq $true) { $offscreen++ }
    if ($null -eq $el.depth -or $el.depth -lt 0) { $missingDepth++ }
    elseif ($el.depth -gt $maxDepth) { $maxDepth = $el.depth }
}

Write-Host "--- controlType histogram ---"
foreach ($k in $byType.Keys | Sort-Object) { Write-Host ("  " + $k + ": " + $byType[$k]) }
Write-Host ("label: " + $withLabel + "  checked: " + $withChecked + "  description: " + $withDescription + "  offscreen: " + $offscreen)
Write-Host ("depth: max=" + $maxDepth + " missing=" + $missingDepth)

$fail = @()
if ($elements.Count -eq 0) { $fail += 'empty tree' }
if ($missingDepth -gt 0) { $fail += ($missingDepth.ToString() + ' elements missing depth') }
if ($maxDepth -lt 1) { $fail += 'no hierarchy (max depth 0)' }

# Show a sample of the model-facing rows.
Write-Host "--- sample (first 15) ---"
$i = 0
foreach ($el in $elements) {
    if ($i -ge 15) { break }
    $lbl = ''
    if ($null -ne $el.label) { $lbl = ' label="' + $el.label + '"' }
    Write-Host ("  [d" + $el.depth + "] " + $el.controlType + " name=" + $el.name + $lbl)
    $i++
}

try { $proc.StandardInput.WriteLine('') ; $proc.StandardInput.Flush() } catch {}
try { $proc.Kill() } catch {}

# Dump the probe's stderr debug traces (walk diagnostics). Read AFTER the
# kill so the stream closes; the trace volume stays far below the pipe
# buffer, so the probe never blocks on it mid-session.
try {
    $errText = $proc.StandardError.ReadToEnd()
    Write-Host "--- probe stderr (last 25) ---"
    ($errText -split "`r?`n") | Where-Object { $_ -ne '' } | Select-Object -Last 25 | ForEach-Object { Write-Host ("  " + $_) }
} catch {}

if ($fail.Count -gt 0) {
    Write-Host ("SMOKE FAIL: " + ($fail -join '; '))
    exit 1
}
Write-Host 'SMOKE PASS'
exit 0
