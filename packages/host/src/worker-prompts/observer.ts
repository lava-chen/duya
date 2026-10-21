/**
 * Prompt section digests — the observation seam for the assembled prompt.
 *
 * Plan 619 Phase 0: before moving any content between channels, the
 * project needs to know WHICH parts of the prompt actually change
 * between turns. The assembled system prompt is a single string by the
 * time it leaves the session runtime, so the evidence has to be taken
 * where the pieces still have names.
 *
 * Two producers report into this sink:
 *   - `PromptSystem.buildSystemPrompt` — one digest per rendered section.
 *   - the session runtime — one digest per host-appended block
 *     (identity, prefix, MCP catalog, apps, AGENTS.md, bot, deferred).
 *
 * The sink is process-level and opt-in: with no observer installed the
 * producers skip hashing entirely, so an uninstrumented build pays
 * nothing for the instrumentation.
 */

import { createHash } from 'node:crypto';

/** One rendered piece of the prompt, identified by where it came from. */
export interface PromptSectionDigest {
  /** Section name (registry key or explicit `name`), or the host block id. */
  readonly sectionName: string
  /** SHA-256 of the section's UTF-8 bytes, hex encoded. */
  readonly hash: string
  /** Character length of the rendered section. */
  readonly length: number
  /**
   * True for sections recomputed on every build (`every-call` cache
   * policy) — the ones that are candidates for the context channel.
   */
  readonly volatile: boolean
}

/** Sink for digests. Called once per build with every section it produced. */
export type PromptObserver = (digests: readonly PromptSectionDigest[]) => void;

let observer: PromptObserver | undefined;

/** Install (or clear, with `undefined`) the process-level observer. */
export function setPromptObserver(next: PromptObserver | undefined): void {
  observer = next
}

/** True when a digest sink is installed. Producers skip hashing otherwise. */
export function hasPromptObserver(): boolean {
  return observer !== undefined
}

/** Report digests to the installed sink. A no-op when none is installed. */
export function reportPromptDigests(digests: readonly PromptSectionDigest[]): void {
  if (!observer) return
  try {
    observer(digests)
  } catch {
    // Observation is optional and must never interrupt prompt assembly.
  }
}

/** SHA-256 of a rendered section's bytes, hex encoded. */
export function digestOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/** Build one digest entry for a rendered section. */
export function sectionDigest(
  sectionName: string,
  content: string,
  volatile: boolean,
): PromptSectionDigest {
  return {
    sectionName,
    hash: digestOf(content),
    length: content.length,
    volatile,
  }
}
