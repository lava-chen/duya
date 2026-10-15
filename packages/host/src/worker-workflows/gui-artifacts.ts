/**
 * gui-artifacts.ts — externalized artifact storage for gui-node journals
 * (plan 552 §4.3 point 5 + §6.1: screenshots never enter the journal blob
 * — the record carries a REFERENCE, the bytes live on disk / in memory).
 *
 * The journal stays small and replayable; the console (Phase 7) resolves
 * refs back to bytes when rendering the step replay view.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ArtifactStore {
  /** Store bytes and return a stable reference (journal-safe, JSON-ready). */
  put(runId: string, name: string, bytes: Buffer | string, ext?: string): Promise<string>;
  /** Resolve a reference back to bytes (null when evicted/missing). */
  get(ref: string): Promise<Buffer | null>;
}

/** In-memory store — tests and short-lived runs. */
export class MemoryArtifactStore implements ArtifactStore {
  private readonly blobs = new Map<string, Buffer>();

  async put(runId: string, name: string, bytes: Buffer | string, ext = '.bin'): Promise<string> {
    const ref = `${runId}/${name}${ext}`;
    this.blobs.set(ref, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8'));
    return ref;
  }

  async get(ref: string): Promise<Buffer | null> {
    return this.blobs.get(ref) ?? null;
  }
}

/** File-backed store: `<root>/<runId>/<name><ext>`, refs are root-relative. */
export class FsArtifactStore implements ArtifactStore {
  constructor(private readonly root: string) {
    fs.mkdirSync(root, { recursive: true });
  }

  async put(runId: string, name: string, bytes: Buffer | string, ext = '.bin'): Promise<string> {
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
    const rel = path.join(runId, `${safeName}${ext}`);
    const abs = path.join(this.root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8'));
    return rel;
  }

  async get(ref: string): Promise<Buffer | null> {
    const abs = path.join(this.root, ref);
    if (!abs.startsWith(this.root)) return null; // traversal guard
    try {
      return fs.readFileSync(abs);
    } catch {
      return null;
    }
  }
}
