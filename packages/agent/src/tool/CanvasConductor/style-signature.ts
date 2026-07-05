/**
 * Style signature extraction for widget/dynamic elements.
 *
 * Used by canvas creation tools to build a lightweight history of recently
 * used styles. The conductor prompt consumes this history to nudge the model
 * toward visual diversity (anti-slop).
 */

import type { ToolUseContext } from '../../types.js';

export type WidgetStyleSignature = NonNullable<ToolUseContext['widgetStyleHistory']>[number];

/**
 * Extract a coarse style signature from widget/dynamic sourceCode.
 * Matches are intentionally permissive — they only need to capture the
 * dominant palette and layout family so the model can vary them.
 */
export function extractWidgetStyleSignature(sourceCode: string): WidgetStyleSignature {
  const signature: WidgetStyleSignature = {};

  const bgMatch = sourceCode.match(
    /background(?:-color)?\s*[:=]\s*(#[0-9a-fA-F]{3,8}|rgb[a]?\([^)]+\)|[a-zA-Z]+)/i,
  );
  if (bgMatch) signature.backgroundColor = bgMatch[1];

  // Use a negative lookbehind to avoid matching border-color, outline-color, etc.
  const colorMatch = sourceCode.match(
    /(?<!border-|outline-|background-|box-shadow-|text-shadow-)color\s*[:=]\s*(#[0-9a-fA-F]{3,8}|rgb[a]?\([^)]+\)|[a-zA-Z]+)/i,
  );
  if (colorMatch) signature.textColor = colorMatch[1];

  const fontMatch = sourceCode.match(/font-family\s*[:=]\s*["']?([^"';,]+)/i);
  if (fontMatch) signature.fontFamily = fontMatch[1].trim().replace(/^["']|["']$/g, '');

  if (/display\s*:\s*grid|grid-template-columns/i.test(sourceCode)) {
    signature.layoutType = 'grid';
  } else if (/display\s*:\s*flex/i.test(sourceCode)) {
    signature.layoutType = 'flex';
  } else if (/<svg[\s>]/i.test(sourceCode)) {
    signature.layoutType = 'svg';
  } else if (/<table[\s>]/i.test(sourceCode)) {
    signature.layoutType = 'table';
  } else {
    signature.layoutType = 'block';
  }

  return signature;
}

/**
 * Append a signature to the rolling history, keeping only the most recent 3.
 */
export function appendWidgetStyleSignature(
  history: WidgetStyleSignature[] | undefined,
  signature: WidgetStyleSignature,
): WidgetStyleSignature[] {
  const next = history ? [...history, signature] : [signature];
  while (next.length > 3) {
    next.shift();
  }
  return next;
}
