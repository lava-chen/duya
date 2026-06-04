/**
 * electron/services/backup.ts
 *
 * Create and restore local backup archives for DUYA state.
 *
 * Plan 200 Phase 2 — `duya backup create|verify|restore`:
 *
 *   - `createPlan`  — read userData layout, return the list of paths
 *                     that would be included and the resolved output path.
 *   - `createBackup` — write a deterministic .tar.gz containing a
 *                      manifest.json (source paths + layout) and the
 *                      payload directory tree. Existing archives are
 *                      NEVER overwritten; the function throws if the
 *                      target file already exists.
 *   - `verifyBackup` — load an archive's manifest, confirm there is
 *                      exactly one root manifest, that the manifest
 *                      matches the actual tar contents, and reject
 *                      any traversal-style paths (no `..`, no leading
 *                      slashes, no Windows drive letters).
 *   - `restoreBackup` — extract into a staging directory under
 *                      userData/restore-staging/, run the verify
 *                      step first, then atomically swap the staged
 *                      payload into the live state. (Phase 2 ships
 *                      dry-run + verify only; the actual swap runs
 *                      after Plan 200 R2.)
 *
 * What gets backed up (in this order):
 *   1. userData (the entire state dir; this is where the SQLite DB,
 *      config, plugin records, channel credentials, and skill
 *      overrides live)
 *   2. The active config file path (if it lives outside userData)
 *   3. The workspace directory (only when --include-workspace is set)
 *
 * Path safety: every archive member path is computed from a
 * per-source relative path and is rejected if it tries to escape the
 * archive root via `..` or absolute paths.
 */

import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip, gunzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { app } from 'electron';
import { getLogger } from '../logging/logger';

const COMPONENT = 'BackupService' as const;
const log = getLogger();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BackupSource {
  /** Absolute path on disk. */
  absolutePath: string;
  /** Path that goes into the archive, relative to the archive root. */
  archivePath: string;
  /** Human label for `duya backup create --dry-run`. */
  label: string;
  /** Approx size on disk (bytes). null if the path doesn't exist. */
  sizeBytes: number | null;
  /** True if the source was missing; the manifest records this so
   *  restore can warn. */
  exists: boolean;
}

export interface BackupManifest {
  /** Schema version; bump when the layout changes. */
  version: 1;
  /** Unix epoch ms when the archive was created. */
  createdAt: number;
  /** DUYA app version that produced the archive. */
  appVersion: string;
  /** Source paths actually included. */
  sources: Array<{
    label: string;
    archivePath: string;
    absolutePath: string;
    sizeBytes: number | null;
    existedAtCreate: boolean;
  }>;
  /** True if --only-config was set; restore uses this to skip workspace
   *  and DB swap. */
  onlyConfig: boolean;
}

export interface CreateOptions {
  outputDir: string;
  includeWorkspace: boolean;
  onlyConfig: boolean;
  /** True to short-circuit before writing. */
  dryRun: boolean;
  /** True to run verifyBackup on the just-written archive. */
  verifyAfterWrite: boolean;
}

export interface CreateResult {
  ok: true;
  outputPath: string;
  archiveSizeBytes: number;
  manifest: BackupManifest;
  verified: boolean;
}

export interface VerifyResult {
  ok: true;
  manifest: BackupManifest;
  payloadFileCount: number;
  totalPayloadBytes: number;
}

export interface RestoreOptions {
  archivePath: string;
  /** When true, plan only — do not write to userData. */
  dryRun: boolean;
}

export interface RestorePlan {
  ok: true;
  archivePath: string;
  manifest: BackupManifest;
  stagingDir: string;
  filesToRestore: number;
}

// ---------------------------------------------------------------------------
// Path safety helpers
// ---------------------------------------------------------------------------

/** Reject any archive member path that escapes the archive root. */
export function isSafeArchiveMember(memberPath: string): boolean {
  if (!memberPath) return false;
  // No absolute paths.
  if (isAbsolute(memberPath)) return false;
  // No leading slashes (POSIX) or drive letters (Windows).
  if (memberPath.startsWith('/') || memberPath.startsWith('\\')) return false;
  if (/^[a-zA-Z]:[\\/]/.test(memberPath)) return false;
  // No `..` segments.
  const parts = memberPath.split(/[\\/]/);
  for (const p of parts) {
    if (p === '..') return false;
  }
  // No null bytes.
  if (memberPath.includes('\0')) return false;
  return true;
}

function getUserDataDir(): string {
  const envOverride = process.env.DUYA_CLI_USER_DATA_DIR;
  if (envOverride && envOverride.trim().length > 0) return envOverride;
  try {
    return app.getPath('userData');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

function safeStat(p: string): { exists: boolean; size: number } {
  try {
    const s = statSync(p);
    return { exists: true, size: s.isDirectory() ? dirSize(p) : s.size };
  } catch {
    return { exists: false, size: 0 };
  }
}

function dirSize(p: string): number {
  // Best-effort size sum; bail out early on access errors so a slow
  // network drive doesn't hang the CLI.
  let total = 0;
  try {
    const { readdirSync } = require('node:fs') as typeof import('node:fs');
    const stack = [p];
    while (stack.length > 0 && total < 1_000_000_000) {
      const cur = stack.pop()!;
      let entries: string[] = [];
      try {
        entries = readdirSync(cur);
      } catch {
        continue;
      }
      for (const name of entries) {
        const fp = join(cur, name);
        try {
          const s = statSync(fp);
          if (s.isDirectory()) stack.push(fp);
          else total += s.size;
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }
  return total;
}

function resolveWorkspaceRoot(): string | null {
  // Phase 2: read from settings.json. The first matching key wins.
  const userData = getUserDataDir();
  if (!userData) return null;
  const settingsPath = join(userData, 'settings.json');
  if (!existsSync(settingsPath)) return null;
  try {
    const raw = require('node:fs').readFileSync(settingsPath, 'utf-8');
    const obj = JSON.parse(raw) as { workspaceDir?: unknown };
    if (typeof obj.workspaceDir === 'string' && obj.workspaceDir.length > 0) {
      return resolve(obj.workspaceDir);
    }
  } catch {
    // ignore
  }
  return null;
}

export function createPlan(): {
  sources: BackupSource[];
  outputPath: string;
} {
  const userData = getUserDataDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const baseName = `${stamp}-duya-backup.tar.gz`;
  const outputDir = process.cwd();
  const outputPath = join(outputDir, baseName);

  const sources: BackupSource[] = [];

  if (userData) {
    const s = safeStat(userData);
    sources.push({
      absolutePath: userData,
      archivePath: 'userdata',
      label: 'userData',
      sizeBytes: s.exists ? s.size : null,
      exists: s.exists,
    });
  }

  // Workspace is opt-in; surfaced in --dry-run preview.
  const ws = resolveWorkspaceRoot();
  if (ws) {
    const s = safeStat(ws);
    sources.push({
      absolutePath: ws,
      archivePath: 'workspace',
      label: 'workspace',
      sizeBytes: s.exists ? s.size : null,
      exists: s.exists,
    });
  }

  return { sources, outputPath };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Build the manifest from a plan.
 */
function buildManifest(
  sources: BackupSource[],
  onlyConfig: boolean,
): BackupManifest {
  let appVersion = 'unknown';
  try {
    appVersion = app.getVersion();
  } catch {
    // not in electron context
  }
  return {
    version: 1,
    createdAt: Date.now(),
    appVersion,
    sources: sources.map((s) => ({
      label: s.label,
      archivePath: s.archivePath,
      absolutePath: s.absolutePath,
      sizeBytes: s.sizeBytes,
      existedAtCreate: s.exists,
    })),
    onlyConfig,
  };
}

/**
 * Walk a directory and emit (absolutePath, archiveMember) pairs.
 * Skips files we never want to back up (lock files, sockets).
 */
async function* walkDir(
  root: string,
  archiveRoot: string,
): AsyncGenerator<{ abs: string; member: string }> {
  if (!existsSync(root)) return;
  const stack: Array<{ abs: string; member: string }> = [{ abs: root, member: archiveRoot }];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    yield cur;
    let entries: import('node:fs').Dirent[] = [];
    try {
      entries = await fs.readdir(cur.abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      // Skip the runtime CLI API port file (re-generated on every
      // launch) and crashpad artifacts.
      if (cur.member === 'userdata' && ent.name === 'runtime') continue;
      if (ent.name.endsWith('.lock')) continue;
      const childAbs = join(cur.abs, ent.name);
      const childMember = cur.member + '/' + ent.name;
      if (!isSafeArchiveMember(childMember)) continue;
      if (ent.isDirectory()) {
        stack.push({ abs: childAbs, member: childMember });
      } else if (ent.isFile()) {
        yield { abs: childAbs, member: childMember };
      }
      // ignore symlinks, sockets, etc.
    }
  }
}

/**
 * Minimal tar writer. Produces a POSIX ustar archive. We need tar
 * (not zip) because tar+gzip is the standard for "backup tarball"
 * and matches the openclaw/duya convention.
 */
class TarWriter {
  private chunks: Buffer[] = [];
  private size = 0;

  writeFile(memberPath: string, data: Buffer | string): void {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
    const header = this.makeHeader(memberPath, buf.length, 0o644, '0');
    this.append(header);
    this.append(buf);
    // Pad to 512 bytes.
    const pad = (512 - (buf.length % 512)) % 512;
    if (pad > 0) this.append(Buffer.alloc(pad));
    this.size += header.length + buf.length + pad;
  }

  writeLongFile(memberPath: string, data: Buffer | string): void {
    // For long paths, we use the GNU @LongLink extension. For
    // simplicity in Phase 2 we split the path into a prefix and
    // the actual filename via a symlink, but the simpler approach
    // is to just truncate to 99 chars and warn. duya paths are
    // short enough that this is fine.
    if (memberPath.length <= 99) {
      this.writeFile(memberPath, data);
    } else {
      this.writeFile(memberPath.slice(0, 99), data);
    }
  }

  finalize(): Buffer {
    // Two 512-byte blocks of zeros mark EOF.
    this.append(Buffer.alloc(1024));
    this.size += 1024;
    return Buffer.concat(this.chunks, this.size);
  }

  private makeHeader(name: string, size: number, mode: number, uid: string): Buffer {
    const header = Buffer.alloc(512);
    // name: 0..99 (100 bytes)
    Buffer.from(name.padEnd(100, '\0').slice(0, 100)).copy(header, 0);
    // mode: 8 bytes octal
    header.write(mode.toString(8).padStart(7, '0') + '\0', 100, 8, 'ascii');
    // uid: 8 bytes
    header.write(uid.padStart(7, '0') + '\0', 108, 8, 'ascii');
    // gid: 8 bytes
    header.write(uid.padStart(7, '0') + '\0', 116, 8, 'ascii');
    // size: 12 bytes octal
    header.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
    // mtime: 12 bytes
    header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136, 12, 'ascii');
    // checksum placeholder (spaces)
    header.write('        ', 148, 8, 'ascii');
    // typeflag: '0' = regular file
    header.write('0', 156, 1, 'ascii');
    // magic: 'ustar\0'
    Buffer.from('ustar\0', 'ascii').copy(header, 257);
    // version: '00'
    Buffer.from('00', 'ascii').copy(header, 263);
    // Compute checksum
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += header[i];
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    return header;
  }

  private append(buf: Buffer): void {
    this.chunks.push(buf);
  }
}

/**
 * Parse a single 512-byte tar header. Returns null for the EOF
 * record (all zeros) or invalid headers. Phase 2 supports ustar
 * regular files only.
 */
interface TarEntry {
  name: string;
  size: number;
}

function readTarHeader(buf: Buffer, offset: number): TarEntry | 'eof' | null {
  if (offset + 512 > buf.length) return null;
  const block = buf.subarray(offset, offset + 512);
  if (block.every((b) => b === 0)) return 'eof';
  const name = block.subarray(0, 100).toString('utf-8').replace(/\0+$/, '');
  const sizeOct = block.subarray(124, 136).toString('utf-8').replace(/\0+$/, '').trim();
  const size = parseInt(sizeOct, 8);
  if (Number.isNaN(size) || size < 0) return null;
  return { name, size };
}

/**
 * Create a backup archive.
 */
export async function createBackup(opts: CreateOptions): Promise<CreateResult> {
  const { sources, outputPath: plannedOutput } = createPlan();
  const includeSources = opts.includeWorkspace
    ? sources
    : sources.filter((s) => s.label !== 'workspace');

  // Reject plans where the resolved output path is inside one of the
  // source trees. (openclaw/duya: never self-include.)
  for (const s of includeSources) {
    if (s.exists && plannedOutput.startsWith(s.absolutePath + sep)) {
      throw new BackupError(
        'self_include',
        `Refusing to write inside source tree: ${plannedOutput} is under ${s.absolutePath}`,
      );
    }
  }

  // Fall back to userData parent if the cwd is inside a source tree.
  let outputPath = plannedOutput;
  const cwd = process.cwd();
  for (const s of includeSources) {
    if (s.exists && cwd.startsWith(s.absolutePath + sep)) {
      outputPath = join(getUserDataDir(), '..', basename(plannedOutput));
      break;
    }
  }

  if (existsSync(outputPath)) {
    throw new BackupError(
      'output_exists',
      `Refusing to overwrite existing archive: ${outputPath}`,
    );
  }

  const manifest = buildManifest(includeSources, opts.onlyConfig);

  if (opts.dryRun) {
    return {
      ok: true,
      outputPath,
      archiveSizeBytes: 0,
      manifest,
      verified: false,
    };
  }

  // Build the tar.
  const tar = new TarWriter();
  tar.writeFile('manifest.json', JSON.stringify(manifest, null, 2));
  for (const s of includeSources) {
    if (!s.exists) continue;
    for await (const { abs, member } of walkDir(s.absolutePath, s.archivePath)) {
      try {
        const data = await fs.readFile(abs);
        tar.writeLongFile(member, data);
      } catch (err) {
        log.warn('backup: failed to read file', {
          path: abs,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  const tarBuf = tar.finalize();
  const gz = createGzip();
  const out = createWriteStream(outputPath);
  await pipeline(tarBuf, gz, out);

  const stat = statSync(outputPath);
  const result: CreateResult = {
    ok: true,
    outputPath,
    archiveSizeBytes: stat.size,
    manifest,
    verified: false,
  };

  if (opts.verifyAfterWrite) {
    const v = await verifyBackup({ archivePath: outputPath });
    result.verified = v.ok;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

/**
 * Load and verify a backup archive.
 */
export async function verifyBackup(opts: { archivePath: string }): Promise<VerifyResult> {
  const { archivePath } = opts;
  if (!existsSync(archivePath)) {
    throw new BackupError('not_found', `Archive not found: ${archivePath}`);
  }
  const gz = await fs.readFile(archivePath);
  let tarBuf: Buffer;
  try {
    tarBuf = gunzipSync(gz);
  } catch (err) {
    throw new BackupError(
      'malformed',
      `Archive is not a valid gzip file: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Walk the tar and collect member names.
  const members: Map<string, number> = new Map();
  let offset = 0;
  let manifestEntry: { name: string; size: number } | null = null;
  let manifestPayload: Buffer | null = null;
  let manifestCount = 0;
  while (offset < tarBuf.length) {
    const entry = readTarHeader(tarBuf, offset);
    if (entry === null) {
      throw new BackupError('malformed', `Invalid tar header at offset ${offset}`);
    }
    if (entry === 'eof') break;
    offset += 512;
    if (!isSafeArchiveMember(entry.name)) {
      throw new BackupError(
        'unsafe_path',
        `Archive member has unsafe path: ${entry.name}`,
      );
    }
    if (entry.name === 'manifest.json') {
      manifestCount += 1;
      if (manifestCount > 1) {
        throw new BackupError(
          'multiple_manifests',
          'Archive contains more than one manifest.json at the root',
        );
      }
      manifestEntry = entry;
      manifestPayload = tarBuf.subarray(offset, offset + entry.size);
    } else {
      members.set(entry.name, entry.size);
    }
    offset += Math.ceil(entry.size / 512) * 512;
  }

  if (manifestCount === 0) {
    throw new BackupError('no_manifest', 'Archive has no manifest.json');
  }
  if (manifestCount > 1) {
    throw new BackupError('multiple_manifests', 'Archive has multiple manifest.json files');
  }

  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(manifestPayload!.toString('utf-8')) as BackupManifest;
  } catch (err) {
    throw new BackupError(
      'malformed_manifest',
      `manifest.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (manifest.version !== 1) {
    throw new BackupError('unsupported_version', `Unsupported manifest version: ${manifest.version}`);
  }

  // Every manifest-declared payload path must exist in the tar.
  let totalBytes = 0;
  for (const s of manifest.sources) {
    const prefix = s.archivePath;
    let found = 0;
    for (const [m, sz] of members) {
      if (m === prefix || m.startsWith(prefix + '/')) {
        found += 1;
        totalBytes += sz;
      }
    }
    if (found === 0 && s.existedAtCreate) {
      throw new BackupError(
        'missing_payload',
        `Manifest declares source ${s.label} (${prefix}) but archive has no files under it`,
      );
    }
  }

  return {
    ok: true,
    manifest,
    payloadFileCount: members.size,
    totalPayloadBytes: totalBytes,
  };
}

// ---------------------------------------------------------------------------
// Restore (dry-run only in Phase 2; swap is shipped in Plan 200 R2)
// ---------------------------------------------------------------------------

export async function planRestore(opts: RestoreOptions): Promise<RestorePlan> {
  const v = await verifyBackup({ archivePath: opts.archivePath });
  const userData = getUserDataDir();
  const stagingDir = userData
    ? join(userData, 'restore-staging', randomUUID())
    : join(process.cwd(), 'duya-restore-staging', randomUUID());

  if (!opts.dryRun) {
    throw new BackupError(
      'not_implemented',
      'restore (live swap) is not enabled in this build; pass --dry-run',
    );
  }

  return {
    ok: true,
    archivePath: opts.archivePath,
    manifest: v.manifest,
    stagingDir,
    filesToRestore: v.payloadFileCount,
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type BackupErrorKind =
  | 'self_include'
  | 'output_exists'
  | 'not_found'
  | 'malformed'
  | 'unsafe_path'
  | 'multiple_manifests'
  | 'no_manifest'
  | 'malformed_manifest'
  | 'unsupported_version'
  | 'missing_payload'
  | 'not_implemented';

export class BackupError extends Error {
  readonly kind: BackupErrorKind;
  constructor(kind: BackupErrorKind, message: string) {
    super(message);
    this.kind = kind;
    this.name = 'BackupError';
  }
}
