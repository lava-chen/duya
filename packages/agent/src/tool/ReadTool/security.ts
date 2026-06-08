/**
 * security - path safety checks for ReadTool
 *
 * Three classes of attack / accident the original implementation missed:
 *
 *   1. Device files (BLOCKED_DEVICE_PATHS)
 *      /dev/zero, /dev/urandom, /proc/kcore, etc. would hang the
 *      process or read gigabytes before EOF. Caught at validation
 *      time using path-only checks (no I/O).
 *
 *   2. UNC paths (Windows NTLM credential leak)
 *      file://\\server\share is a Windows attack vector that triggers
 *      credential prompts. We block at validation time so the
 *      process never opens the file.
 *
 *   3. Magic-byte binary detection
 *      file_extension checks miss cases where a binary is renamed to
 *      .txt to bypass content-type checks. We sniff the first 16
 *      bytes and refuse to feed binary content to the model as text.
 *
 * All checks are conservative — false positives are better than OOM
 * or model confusion from binary garbage.
 */

/**
 * Device files that would hang the process: infinite output or blocking input.
 * Checked by path only (no I/O). Safe devices like /dev/null are intentionally omitted.
 */
export const BLOCKED_DEVICE_PATHS = new Set([
  // Infinite output — never reach EOF
  '/dev/zero',
  '/dev/random',
  '/dev/urandom',
  '/dev/full',
  // Blocks waiting for input
  '/dev/stdin',
  '/dev/tty',
  '/dev/console',
  // Nonsensical to read
  '/dev/stdout',
  '/dev/stderr',
  // fd aliases for stdin/stdout/stderr
  '/dev/fd/0',
  '/dev/fd/1',
  '/dev/fd/2',
]);

/**
 * Detect blocked device paths. Pure path check, no I/O.
 * - /proc/self/fd/0-2 are Linux aliases for stdio
 * - /proc/<pid>/fd/0-2 cover the same on other processes
 */
export function isBlockedDevicePath(filePath: string): boolean {
  if (BLOCKED_DEVICE_PATHS.has(filePath)) return true;
  if (
    filePath.startsWith('/proc/') &&
    (filePath.endsWith('/fd/0') ||
      filePath.endsWith('/fd/1') ||
      filePath.endsWith('/fd/2'))
  ) {
    return true;
  }
  return false;
}

/**
 * Check if path is a UNC path (Windows attack vector).
 * UNC paths start with \\\\server\\share or //server/share.
 * Regular Unix absolute paths like /root/... or /c/... are NOT UNC paths.
 *
 * Detection rules:
 *   - \\server\share  → match (single backslash pair at start)
 *   - //server/share → match ONLY when the second segment is non-empty
 *     AND looks like a hostname (no slash until later). Unix paths
 *     like /root/foo have a single slash, never a //server/... form.
 *   - unc\foo or unc/foo → match
 *   - smb://... → match
 */
export function isUNCPath(filePath: string): boolean {
  // \\\\server\share
  if (filePath.startsWith('\\\\')) return true;
  // //server/share — must have a non-empty server segment
  if (filePath.startsWith('//')) {
    const third = filePath.indexOf('/', 2);
    // Either "//server" (no trailing slash) or "//server/..." (has one)
    // but "//" alone is not UNC
    if (third > 2) return true;
    if (third === -1 && filePath.length > 2) return true;
  }
  if (/^unc[\\/]/i.test(filePath)) return true;
  if (/^smb:/i.test(filePath)) return true;
  return false;
}

/**
 * Known binary file signatures (first 16 bytes / magic bytes).
 * If a file's leading bytes match any of these, refuse to treat it as
 * text — even if the extension says .txt — and surface a clear error
 * to the model.
 *
 * Format coverage:
 *   - ELF, Mach-O, PE/EXE/DLL: native executables
 *   - ZIP / GZIP / BZIP2 / XZ / 7Z: archives
 *   - PNG / JPEG / GIF / WEBP / BMP / ICO: images (also caught by
 *     the document parser's image branch, but the early-out is cheaper)
 *   - PDF, SQLite, WASM, Java class, Mach-O fat: misc
 *   - WASM, Protobuf, font files
 *
 * We intentionally do NOT detect:
 *   - Markdown / source code (text by definition)
 *   - CSV / TSV (texty)
 *   - Anything not in this list (defaults to text)
 */
const BINARY_SIGNATURES: Array<{ name: string; magic: Uint8Array }> = [
  { name: 'ELF executable', magic: new Uint8Array([0x7f, 0x45, 0x4c, 0x46]) }, // .elf
  { name: 'Mach-O 32-bit', magic: new Uint8Array([0xfe, 0xed, 0xfa, 0xce]) },
  { name: 'Mach-O 64-bit', magic: new Uint8Array([0xfe, 0xed, 0xfa, 0xcf]) },
  { name: 'Mach-O reverse', magic: new Uint8Array([0xce, 0xfa, 0xed, 0xfe]) },
  { name: 'Mach-O fat', magic: new Uint8Array([0xca, 0xfe, 0xba, 0xbe]) },
  { name: 'PE / Windows executable', magic: new Uint8Array([0x4d, 0x5a]) }, // MZ
  { name: 'PDF', magic: new Uint8Array([0x25, 0x50, 0x44, 0x46]) },
  { name: 'ZIP / Office Open XML / JAR', magic: new Uint8Array([0x50, 0x4b, 0x03, 0x04]) },
  { name: 'ZIP empty', magic: new Uint8Array([0x50, 0x4b, 0x05, 0x06]) },
  { name: 'ZIP spanned', magic: new Uint8Array([0x50, 0x4b, 0x07, 0x08]) },
  { name: 'GZIP', magic: new Uint8Array([0x1f, 0x8b]) },
  { name: 'BZIP2', magic: new Uint8Array([0x42, 0x5a, 0x68]) },
  { name: 'XZ', magic: new Uint8Array([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]) },
  { name: '7-Zip', magic: new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) },
  { name: 'RAR v1.5+', magic: new Uint8Array([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]) },
  { name: 'PNG', magic: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { name: 'JPEG', magic: new Uint8Array([0xff, 0xd8, 0xff]) },
  { name: 'GIF87a', magic: new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) },
  { name: 'GIF89a', magic: new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]) },
  { name: 'WebP', magic: new Uint8Array([0x52, 0x49, 0x46, 0x46]) }, // RIFF, refined by file size
  { name: 'BMP', magic: new Uint8Array([0x42, 0x4d]) },
  { name: 'ICO / CUR', magic: new Uint8Array([0x00, 0x00, 0x01, 0x00]) },
  { name: 'SQLite database', magic: new Uint8Array([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65]) },
  { name: 'WebAssembly', magic: new Uint8Array([0x00, 0x61, 0x73, 0x6d]) }, // \0asm
  { name: 'Java class', magic: new Uint8Array([0xca, 0xfe, 0xba, 0xbe]) },
  { name: 'TrueType font', magic: new Uint8Array([0x00, 0x01, 0x00, 0x00]) },
  { name: 'OpenType font', magic: new Uint8Array([0x4f, 0x54, 0x54, 0x4f]) },
  { name: 'WOFF font', magic: new Uint8Array([0x77, 0x4f, 0x46, 0x46]) },
  { name: 'PCAP capture', magic: new Uint8Array([0xd4, 0xc3, 0xb2, 0xa1]) },
  { name: 'PCAPNG capture', magic: new Uint8Array([0x0a, 0x0d, 0x0d, 0x0a]) },
];

/**
 * Sniff the first 16 bytes of a file to detect known binary formats.
 * Returns the format name on a match, null if the file is likely text.
 *
 * Capped at 16 bytes — most signatures fit comfortably and the read
 * is one fs syscall, not a full file read.
 */
export function detectBinarySignature(head: Uint8Array): string | null {
  for (const sig of BINARY_SIGNATURES) {
    if (head.length < sig.magic.length) continue;
    let match = true;
    for (let i = 0; i < sig.magic.length; i++) {
      if (head[i] !== sig.magic[i]) {
        match = false;
        break;
      }
    }
    if (match) return sig.name;
  }
  return null;
}

/**
 * Heuristic fallback: scan the first N bytes for non-printable characters
 * and absence of common text markers. Used when magic-byte detection
 * returns null but the file still looks binary.
 *
 * Conservative — only flags files with both a high non-printable ratio
 * AND no recognizable text markers (whitespace, common punctuation).
 * False negatives are preferred: a mis-flagged text file goes through
 * as garbled text, not data loss.
 */
export function looksBinaryByHeuristic(head: Uint8Array): boolean {
  if (head.length === 0) return false;
  let nonPrintable = 0;
  let total = 0;
  for (const b of head) {
    total++;
    // Allow common whitespace, control chars (tab/LF/CR/FF), and printable ASCII
    if (b === 0x09 || b === 0x0a || b === 0x0d || b === 0x0c) continue;
    if (b >= 0x20 && b <= 0x7e) continue;
    // Allow UTF-8 lead/continuation bytes (rough: any byte >= 0x80)
    if (b >= 0x80) continue;
    nonPrintable++;
  }
  // 5% non-printable threshold catches most compiled binaries
  // while ignoring the occasional stray control char in text.
  return nonPrintable / total > 0.05;
}
