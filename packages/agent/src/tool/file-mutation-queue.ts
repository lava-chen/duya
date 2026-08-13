/**
 * file-mutation-queue - serialize write operations that target the same file
 *
 * Mirrors pi's `withFileMutationQueue`. Write tools (write / edit /
 * apply_patch) historically declared `isConcurrencySafe() = false`, which
 * serializes the entire tool in the executor. That is coarser than needed:
 * it blocks edits to *different* files from running in parallel. This queue
 * serializes only operations that touch the *same* resolved path, so unrelated
 * files mutate concurrently while same-file operations stay ordered.
 *
 * The queue key is the realpath of the target file (falling back to the
 * resolved path when the file does not exist yet, e.g. a fresh write), so two
 * aliases of one file (symlinks, case-differing paths) share a single queue.
 */

import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

const fileMutationQueues = new Map<string, Promise<void>>();
let registrationQueue: Promise<void> = Promise.resolve();

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

async function getMutationQueueKey(filePath: string): Promise<string> {
  const resolvedPath = resolve(filePath);
  try {
    return await realpath(resolvedPath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return resolvedPath;
    }
    throw error;
  }
}

/**
 * Serialize file mutation operations targeting the same file.
 * Operations for different files still run in parallel.
 */
export async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const registration = registrationQueue.then(async () => {
    const key = await getMutationQueueKey(filePath);
    const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();

    let releaseNext!: () => void;
    const nextQueue = new Promise<void>((resolveQueue) => {
      releaseNext = resolveQueue;
    });
    const chainedQueue = currentQueue.then(() => nextQueue);
    fileMutationQueues.set(key, chainedQueue);

    return { key, currentQueue, chainedQueue, releaseNext };
  });
  registrationQueue = registration.then(
    () => undefined,
    () => undefined,
  );

  const { key, currentQueue, chainedQueue, releaseNext } = await registration;
  await currentQueue;
  try {
    return await fn();
  } finally {
    releaseNext();
    if (fileMutationQueues.get(key) === chainedQueue) {
      fileMutationQueues.delete(key);
    }
  }
}