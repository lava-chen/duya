/**
 * file-snapshot.ts - capture a pre-image snapshot around a file mutation
 *
 * Wraps the actual write of a file-edit / file-write / apply-patch operation.
 * Before the mutation runs it reads the target file's current content (when the
 * file exists), persists it to the content-addressed store, and returns the
 * address alongside the operation's result. The caller records that address in
 * `ToolResult.metadata.preImageSha` so a future session rewind can restore the
 * pre-edit file. Snapshotting is best-effort and never throws into the caller.
 */

import { readFile } from 'node:fs/promises';
import { FileSnapshotStore, sha256Of } from './file-snapshot-store.js';

export interface WithFileSnapshotResult<T> {
  /** Return value of the wrapped mutation. */
  value: T;
  /** Content address of the pre-image; undefined when the file did not exist. */
  preImageSha?: string;
}

/**
 * Run `fn` while capturing the target file's pre-mutation content. The
 * pre-image address is passed into `fn` as its only argument — the callback
 * runs only after the address is known, so it can record `preImageSha` in its
 * own ToolResult while the pre-image snapshot is already on disk. Returns the
 * mutation's result beam along with the captured address. Reading the file is
 * best-effort: a missing/unreadable target yields `preImageSha = undefined`.
 */
export async function withFileSnapshot<T>(
  filePath: string,
  fn: (preImageSha?: string) => Promise<T>,
  store = new FileSnapshotStore(),
): Promise<WithFileSnapshotResult<T>> {
  let preImageSha: string | undefined;
  try {
    const preImage = await readFile(filePath, 'utf8');
    preImageSha = sha256Of(preImage);
    await store.put(preImage); // dedupes internally; failures are swallowed
  } catch {
    // Missing file (ENOENT) or unreadable target — no pre-image to capture.
    // The caller treats an absent preImageSha as "created-new, nothing to restore".
  }

  const value = await fn(preImageSha);
  return { value, preImageSha };
}