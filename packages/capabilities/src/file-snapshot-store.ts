/**
 * file-snapshot-store - content-addressed pre-image snapshots for file tools
 *
 * Plan 429 #3: Edit/Write/ApplyPatch have no pre-image backup today, so a
 * session rewind rewrites only the conversation timeline — the files on disk
 * do not roll back. This store gives every file-mutating turn a cheap,
 * deduplicated pre-image snapshot that a future rewind handler can restore.
 *
 * Layout: `~/.duya/snapshots/<sha256>.blob` — content-addressed, so the same
 * pre-image content is stored exactly once regardless of how many edits /
 * sessions reference it. Mirrors the `~/.duya/` convention used by skills,
 * memory, cache, and attachments (already in the agent's allowed-dirs set).
 *
 * The store is intentionally minimal: `put` returns a content address,
 * `get` reads a snapshot back by address, `has` guards deduplication. Callers
 * (the write tools) record the returned address in `ToolResult.metadata` so
 * the address flows into the persisted tool_call event without extending the
 * cross-process message protocol.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';

/** Root directory for content-addressed file snapshots. */
export function getSnapshotRootDir(): string {
  return path.join(os.homedir(), '.duya', 'snapshots');
}

/** Compute the content address (sha256 hex) for a byte buffer / string. */
export function sha256Of(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Content-addressed pre-image snapshot store. Methods are idempotent and
 * best-effort: a write failure must never fail the underlying tool.
 */
export class FileSnapshotStore {
  constructor(private readonly rootDir: string = getSnapshotRootDir()) {}

  /** Absolute path where the snapshot with the given address lives. */
  private blobPath(address: string): string {
    return path.join(this.rootDir, `${address}.blob`);
  }

  /** Return the address of `content` after persisting it if not already stored. */
  async put(content: Buffer | string): Promise<string> {
    const address = sha256Of(content);
    try {
      await this.ensurePut(address, content);
    } catch {
      // Best-effort: never let a snapshot write failure surface as a tool error.
    }
    return address;
  }

  private async ensurePut(address: string, content: Buffer | string): Promise<void> {
    const blobPath = this.blobPath(address);
    try {
      await fs.access(blobPath);
      return; // already stored — deduplicated
    } catch {
      // not present — fall through to write
    }
    try {
      await fs.mkdir(this.rootDir, { recursive: true });
    } catch {
      // mkdir raced / root exists — write will surface any real error
    }
    await fs.writeFile(blobPath, content, 'utf8');
  }

  /** Return the stored content for `address`, or null when absent. */
  async get(address: string): Promise<string | null> {
    try {
      return await fs.readFile(this.blobPath(address), 'utf8');
    } catch {
      return null;
    }
  }

  /** Whether a snapshot for `address` is already on disk. */
  async has(address: string): Promise<boolean> {
    try {
      await fs.access(this.blobPath(address));
      return true;
    } catch {
      return false;
    }
  }
}