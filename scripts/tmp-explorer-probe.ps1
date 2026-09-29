# tmp-explorer-probe.ps1 — drive the persistent uia-probe against an
# explorer.exe window and dump the walk result (plan 576 verification).

$ErrorActionPreference = 'Stop'

function Wait-Response([System.Diagnostics.Process]$p, [int]$wantId, [int]$timeoutMs) {
    $deadline = [DateTime]::UtcNow.AddMilliseconds($timeoutMs)
    while ([DateTime]::UtcNow -lt $deadline) {
        $line = $p.StandardOutput.ReadLine()
        if ($null -eq $line) { throw 'probe stdout closed' }
        try { $json = $line | ConvertFrom-Json } catch { continue }
        if ($json.id -eq $wantId) { return $json }
    }
    throw ("timeout waiting for response id " + $wantId)
}

function Probe-Window([System.Diagnostics.Process]$p, [int]$id, [int]$hwnd) {
    $p.StandardInput.WriteLine(('{"id":' + $id + ',"op":"enumerate","hwnd":' + $hwnd + ',"totalMs":8000}'))
    $p.StandardInput.Flush()
    return Wait-Response $p $id 15000
}

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
$null = $proc.StandardOutput.ReadLine()  # {"ready":true}

$explorerPids = @(Get-Process -Name explorer -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
Write-Host ("explorer pids: " + ($explorerPids -join ','))

$reqId = 10
foreach ($epid in $explorerPids) {
    $proc.StandardInput.WriteLine(('{"id":' + $reqId + ',"op":"windows","pid":' + $epid + '}'))
    $proc.StandardInput.Flush()
    $wins = Wait-Response $proc $reqId 10000
    $reqId += 1
    Write-Host ("raw windows for pid " + $epid + ":")
    foreach ($w in $wins.windows) {
        Write-Host ("  hwnd=" + $w.hwnd + " min=" + $w.minimized + " cloaked=" + $w.cloaked + " rect=" + $w.rect.x + "," + $w.rect.y + " title=[" + $w.title + "]")
    }
    foreach ($w in $wins.windows) {
        if ($w.hwnd -le 0) { continue }
        Write-Host ("--- enumerate hwnd=" + $w.hwnd + " title=[" + $w.title + "] min=" + $w.minimized)
        $tree = Probe-Window $proc $reqId $w.hwnd
        $reqId += 1
        if ($tree.ok -eq $true) {
            $els = $tree.elements
            Write-Host ("  enumerate ok: count=" + $els.Count + " truncated=" + $tree.truncated)
            $types = @{}
            $off = 0
            foreach ($el in $els) {
                $t = $el.controlType
                if ($types.ContainsKey($t)) { $types[$t] = $types[$t] + 1 } else { $types[$t] = 1 }
                if ($el.offscreen -eq $true) { $off++ }
            }
            Write-Host ("  offscreen-flagged: " + $off)
            foreach ($k in $types.Keys | Sort-Object) { Write-Host ("    " + $k + ": " + $types[$k]) }
            $i = 0
            foreach ($el in $els) {
                if ($i -ge 14) { break }
                $lbl = ''
                if ($null -ne $el.label) { $lbl = ' label="' + $el.label + '"' }
                Write-Host ("    [d" + $el.depth + "] " + $el.controlType + " name=" + $el.name + $lbl)
                $i++
            }
        } else {
            Write-Host ("  enumerate FAILED: " + $tree.reason)
        }
    }
}

try { $proc.Kill() } catch {}
try {
    $errText = $proc.StandardError.ReadToEnd()
    ($errText -split "`r?`n") | Where-Object { $_ -ne '' } | Select-Object -Last 12 | ForEach-Object { Write-Host ("  stderr: " + $_) }
} catch {}
