/**
 * file-diff.ts — compute the structured diff a file-mutating tool publishes.
 *
 * A tool that mutates a file is the only place that holds both the pre-image
 * and the post-image at the same time, so it is the only place a diff can be
 * computed honestly. This module turns that pair into the wire contract in
 * `@duya/agent-protocol/tool-file-diff`: rows that already carry their
 * pre-image and post-image line numbers, so every consumer renders the same
 * numbers instead of re-deriving them from text.
 *
 * The rows are capped. A diff travels inside a tool result's metadata, which
 * travels inside an SSE event; a 20 000-line rewrite would otherwise put
 * megabytes on the wire to paint a screen that cannot show them. When the cap
 * bites, the counts stay exact and the rows are dropped with `truncated`, so a
 * summary line remains truthful while the payload stays bounded.
 */

import { structuredPatch } from 'diff';
import type { ToolDiffHunk, ToolDiffLine, ToolFileDiff } from '@duya/agent-protocol/tool-file-diff';

/** Rows one file's diff may carry before the rows are dropped. */
export const MAX_DIFF_ROWS = 400;

/** Bytes one file's diff may carry before the rows are dropped. */
export const MAX_DIFF_BYTES = 64 * 1024;

/** Context rows kept around each change, matching the git default. */
const CONTEXT_LINES = 3;

export interface FileDiffInput {
  /** Path the change applies to, as the producer resolved it. */
  readonly path: string;
  /** Full pre-image text; empty string for a file that did not exist. */
  readonly oldText: string;
  /** Full post-image text. */
  readonly newText: string;
  /** Pre-image path, when the change was a rename. */
  readonly oldPath?: string;
}

/**
 * Build the diff between two versions of a file, or null when nothing
 * changed. A null result means "no change to show", not "could not compute":
 * a diff that cannot be computed is still a real change, so it is reported as
 * a truncated diff rather than swallowed.
 */
export function buildFileDiff(input: FileDiffInput): ToolFileDiff | null {
  const { path, oldText, newText, oldPath } = input;
  if (oldText === newText) return null;

  let hunks: ToolDiffHunk[];
  let added = 0;
  let removed = 0;
  let rows = 0;
  let bytes = 0;

  try {
    const patch = structuredPatch(oldPath ?? path, path, oldText, newText, undefined, undefined, {
      context: CONTEXT_LINES,
    });

    hunks = [];
    for (const hunk of patch.hunks) {
      const lines: ToolDiffLine[] = [];
      let oldCursor = hunk.oldStart;
      let newCursor = hunk.newStart;

      for (const raw of hunk.lines) {
        const marker = raw.charAt(0);
        // "\ No newline at end of file" — a file-ending marker, not a row.
        if (marker === '\\') continue;
        const text = stripLineEnding(raw.slice(1));

        if (marker === ' ') {
          lines.push({ kind: 'context', text, oldLine: oldCursor, newLine: newCursor });
          oldCursor += 1;
          newCursor += 1;
        } else if (marker === '-') {
          lines.push({ kind: 'remove', text, oldLine: oldCursor, newLine: null });
          removed += 1;
          oldCursor += 1;
        } else if (marker === '+') {
          lines.push({ kind: 'add', text, oldLine: null, newLine: newCursor });
          added += 1;
          newCursor += 1;
        } else {
          continue;
        }

        rows += 1;
        bytes += text.length + 1;
      }

      hunks.push({
        oldStart: hunk.oldStart,
        oldLines: hunk.oldLines,
        newStart: hunk.newStart,
        newLines: hunk.newLines,
        lines,
      });
    }
  } catch {
    // The diff could not be computed. Report the change as a truncated diff so
    // the consumer still knows the file changed.
    return {
      path,
      ...(oldPath === undefined ? {} : { oldPath }),
      added: 0,
      removed: 0,
      truncated: true,
      hunks: [],
    };
  }

  if (added === 0 && removed === 0) return null;

  if (rows > MAX_DIFF_ROWS || bytes > MAX_DIFF_BYTES) {
    return {
      path,
      ...(oldPath === undefined ? {} : { oldPath }),
      added,
      removed,
      truncated: true,
      hunks: [],
    };
  }

  return {
    path,
    ...(oldPath === undefined ? {} : { oldPath }),
    added,
    removed,
    hunks,
  };
}

/**
 * Drop the line terminator a diff row carries. `structuredPatch` already
 * removes the trailing newline; a CRLF file keeps its carriage return, and a
 * row that ends in a stray `\r` renders as a broken glyph.
 */
function stripLineEnding(text: string): string {
  return text.endsWith('\r') ? text.slice(0, -1) : text;
}
