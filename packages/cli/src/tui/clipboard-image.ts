/**
 * Reading attachments out of the Windows clipboard.
 *
 * ## Why PowerShell instead of a native module
 *
 * minimax-code reads the clipboard through `@mariozechner/clipboard` on
 * native Windows. A native dependency is a rebuild burden this repo already
 * pays for better-sqlite3 and node-pty, and the .NET clipboard API is one
 * process away — minimax-code itself uses the exact `Clipboard::GetImage()`
 * form below for its WSL path. The cost is a ~1s cold Add-Type on the first
 * paste, which a screenshot paste never notices.
 *
 * ## What is read
 *
 * An image on the clipboard is saved straight to a PNG in a temp directory
 * (the worker consumes it by path at the start of the turn, and the TUI
 * removes the directory on exit). A copied FILE DROP LIST (Explorer "Copy")
 * yields its paths; those accept ANY extension — an explicit file copy is
 * unambiguous intent, unlike a pasted path (see `attachments.ts`).
 *
 * Plain text is deliberately not reported: text paste is the terminal's own
 * bracketed-paste channel, and reading it here would double-paste.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type ClipboardReadResult =
  | { readonly kind: 'image'; readonly filePath: string }
  | { readonly kind: 'files'; readonly paths: readonly string[] }
  | { readonly kind: 'empty' }
  | { readonly kind: 'unsupported' };

const SCRIPT_TIMEOUT_MS = 10_000;
const RETRY_ATTEMPTS = 2;
const RETRY_DELAY_MS = 150;

/** The temp directory holding clipboard images for this TUI's lifetime. */
let tempDirPromise: Promise<string> | null = null;

function ensureClipboardTempDir(): Promise<string> {
  tempDirPromise ??= mkdtemp(join(tmpdir(), 'duya-tui-clipboard-'));
  return tempDirPromise;
}

/** Remove the clipboard temp directory. Called when the TUI stops. */
export async function disposeClipboardTempDir(): Promise<void> {
  const directory = tempDirPromise;
  tempDirPromise = null;
  if (directory === null) return;
  try {
    await rm(await directory, { recursive: true, force: true });
  } catch {
    // A leaked empty temp dir under $TMP is not worth reporting over.
  }
}

/** Build the PowerShell script. Exposed for tests; `savePath` is pre-created. */
export function buildClipboardScript(savePath: string): string {
  const quoted = '\'' + savePath.replaceAll('\'', '\'\'') + '\'';
  return [
    '$ErrorActionPreference = \'Stop\'',
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    'if ([System.Windows.Forms.Clipboard]::ContainsImage()) {',
    '  $img = [System.Windows.Forms.Clipboard]::GetImage()',
    '  if ($null -ne $img) {',
    `    $img.Save(${quoted}, [System.Drawing.Imaging.ImageFormat]::Png)`,
    `    Write-Output ('IMAGE ' + ${quoted})`,
    '    exit 0',
    '  }',
    '}',
    'if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {',
    '  foreach ($f in [System.Windows.Forms.Clipboard]::GetFileDropList()) { Write-Output (\'FILE \' + $f) }',
    '  exit 0',
    '}',
    'Write-Output \'EMPTY\'',
    'exit 0',
  ].join('\r\n');
}

/**
 * Parse the script's stdout. Exposed for tests. The prefixes are matched at
 * line start so a stray filename can never be mistaken for a directive.
 */
export function parseClipboardScriptOutput(stdout: string): ClipboardReadResult {
  const imagePrefix = 'IMAGE ';
  const filePrefix = 'FILE ';
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
  const files: string[] = [];
  for (const line of lines) {
    if (line.startsWith(imagePrefix)) return { kind: 'image', filePath: line.slice(imagePrefix.length).trim() };
    if (line.startsWith(filePrefix)) files.push(line.slice(filePrefix.length).trim());
  }
  if (files.length > 0) return { kind: 'files', paths: files };
  return { kind: 'empty' };
}

function runClipboardScript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('clipboard read timed out'));
    }, SCRIPT_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`clipboard read exited with ${code}${stderr.trim() === '' ? '' : ': ' + stderr.trim()}`));
    });
  });
}

async function readWindowsClipboard(): Promise<ClipboardReadResult> {
  const directory = await ensureClipboardTempDir();
  const savePath = join(directory, `clipboard-${Date.now()}.png`);
  const script = buildClipboardScript(savePath);
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= RETRY_ATTEMPTS; attempt += 1) {
    try {
      return parseClipboardScriptOutput(await runClipboardScript(script));
    } catch (error) {
      // OpenClipboard contention with another reader is transient; retrying
      // with a small delay mirrors minimax-code's Windows retry loop.
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Read the clipboard for attachments. Never throws for an ordinary
 * "nothing there" — only a genuinely failed read rejects.
 */
export async function readClipboardAttachments(): Promise<ClipboardReadResult> {
  if (process.platform !== 'win32') return { kind: 'unsupported' };
  return readWindowsClipboard();
}
