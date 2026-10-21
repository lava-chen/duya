/**
 * structural-format.ts — LLM-facing text rendering of a structural
 * element tree (plan 564).
 *
 * The `tree` action returns its payload twice: a machine-readable JSON
 * envelope (for verdicts + click fallback coordinates) and a compact
 * one-line-per-element text block (for the model to read). This module
 * owns the text shape. Design constraints:
 *   - one line per element, `[n] Role "Name"` first (the fields the
 *     model actually targets), metadata after;
 *   - values are quoted + truncated (40 chars) and never emitted for
 *     password fields;
 *   - empty trees render a reason-specific hint so the model knows to
 *     fall back to the vision channel instead of retrying blindly.
 *
 * Pure data — no I/O, no side effects.
 */

import type { UiaTreeElement, UiaTreeResult } from '../backend/types.js';

/** Defaults for the text rendering. */
const DEFAULT_MAX_ELEMENTS = 300;
const DEFAULT_MAX_VALUE_LEN = 40;
const DEFAULT_MAX_NAME_LEN = 80;

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function quote(s: string, max: number): string {
  return `"${truncate(s, max).replace(/"/g, "'")}"`;
}

/**
 * Render one element as a single line. Values come after the name so a
 * long value cannot push the identity fields off small screens. plan
 * 576: unlabeled fields fall back to their absorbed static-text label,
 * and rows indent by the probe's real tree depth.
 */
export function formatTreeElement(el: UiaTreeElement): string {
  const role = el.role ?? 'Unknown';
  const name = el.name ? ` ${quote(el.name, DEFAULT_MAX_NAME_LEN)}` : '';
  const label =
    !el.name && (el as { label?: string }).label
      ? ` ${quote((el as { label?: string }).label as string, DEFAULT_MAX_NAME_LEN)}`
      : '';
  let line = `[${el.index}]${role}${name}${label}`;
  if (el.isPassword === true) {
    line += ' *pw';
  } else if (el.value !== undefined && el.value.length > 0) {
    line += ` value=${quote(el.value, DEFAULT_MAX_VALUE_LEN)}`;
  }
  if (el.rect) {
    line += ` @(${Math.round(el.rect.x)},${Math.round(el.rect.y)} ${Math.round(el.rect.w)}x${Math.round(el.rect.h)})`;
  }
  return line;
}

/**
 * Empty-tree guidance: the model must switch channels, not retry.
 * `reason` comes from the probe (elevated = UIPI skip) or from the
 * backend (unavailable = no structural channel on this platform).
 */
export function emptyTreeHint(result: UiaTreeResult): string {
  if (result.source === 'unavailable') {
    return (
      'Structural channel unavailable on this platform — ' +
      'use the vision loop (capture + click) instead.'
    );
  }
  if (result.reason === 'elevated') {
    return (
      'Window is elevated (UIPI): its UIA tree is unreadable from a ' +
      'non-elevated process — use the vision loop instead.'
    );
  }
  if (result.reason === 'target-unresponsive') {
    return (
      'Window repeatedly ignored the structural walk (UIA provider busy ' +
      'or hung) and is quarantined for a minute — use the vision loop ' +
      '(capture somMode=true + click) instead of retrying tree.'
    );
  }
  return (
    'No interactive elements exposed (custom-drawn window, or browser ' +
    'content without an accessibility tree) — use the vision loop ' +
    '(capture somMode=true + click) instead.'
  );
}

/**
 * Render a whole tree result as LLM-facing text. The header carries the
 * window identity; truncated trees say so explicitly (the model must
 * not assume the list is complete).
 */
export function formatTreeForLlm(
  result: UiaTreeResult,
  opts: { maxElements?: number } = {},
): { text: string; elementCount: number; truncated: boolean } {
  const maxElements = opts.maxElements ?? DEFAULT_MAX_ELEMENTS;
  if (result.source === 'unavailable' || result.elements.length === 0) {
    return {
      text: `UIA tree of ${result.title ? quote(result.title, DEFAULT_MAX_NAME_LEN) : `hwnd ${result.hwnd}`}: empty. ${emptyTreeHint(result)}`,
      elementCount: 0,
      truncated: false,
    };
  }

  const shown = result.elements.slice(0, maxElements);
  const lines = shown.map(formatTreeElement);
  const listTruncated = result.truncated || result.elements.length > shown.length;
  const title = result.title ? quote(result.title, DEFAULT_MAX_NAME_LEN) : `hwnd ${result.hwnd}`;
  const header = `UIA tree of ${title} (${result.processName ?? 'unknown process'}): ${result.elements.length} interactive elements${listTruncated ? ' (TRUNCATED — list may be incomplete)' : ''}:`;

  return {
    text: [header, ...lines].join('\n'),
    elementCount: result.elements.length,
    truncated: listTruncated,
  };
}
