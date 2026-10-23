import { execFile } from 'node:child_process';
import { getSharedAxHelperClient } from './ax-helper.js';

/** Foreground window identity used by the recorder's focus tracker. */
export interface ForegroundWindowInfo {
  hwnd: number;
  pid: number;
  processName: string;
  title: string;
}

function runPowerShell(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 10_000, windowsHide: true, maxBuffer: 1 << 20, encoding: 'utf8' },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

/**
 * Query the foreground OS window without loading the Computer Use backend.
 * macOS uses the shared AX helper; Windows uses user32 via PowerShell.
 */
export async function getForegroundWindowInfo(): Promise<ForegroundWindowInfo | null> {
  if (process.platform === 'darwin') {
    try {
      const fg = await getSharedAxHelperClient().foreground();
      return fg ? { hwnd: fg.windowId, pid: fg.pid, processName: fg.processName, title: fg.title } : null;
    } catch {
      return null;
    }
  }
  if (process.platform !== 'win32') return null;
  try {
    const stdout = await runPowerShell(
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' +
      '$t = Add-Type -MemberDefinition \'[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);\' -Name WinFg -Namespace Native -PassThru; ' +
      '$h = $t::GetForegroundWindow(); if ($h -eq [IntPtr]::Zero) { return; } ' +
      '$procId = 0; $null = $t::GetWindowThreadProcessId($h, [ref]$procId); ' +
      '$p = Get-Process -Id $procId -ErrorAction SilentlyContinue; "{0}`t{1}`t{2}`t{3}" -f $h, $procId, $p.ProcessName, $p.MainWindowTitle',
    );
    const line = stdout.trim().split(/\r?\n/).pop() ?? '';
    const parts = line.split('\t');
    if (parts.length < 4) return null;
    const hwnd = Number(parts[0]);
    const pid = Number(parts[1]);
    if (!Number.isFinite(hwnd) || !Number.isFinite(pid)) return null;
    return { hwnd, pid, processName: parts[2] ?? '', title: parts.slice(3).join('\t') };
  } catch {
    return null;
  }
}
