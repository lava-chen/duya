/**
 * Freshness check for canvas mutation tools.
 *
 * The original STALE_STATE check required canvas_list_elements to be
 * called within 30 seconds before any mutation. This was too strict:
 * the agent often creates elements, then tries to fill/style them,
 * only to be blocked because the list call was >30s ago.
 *
 * New policy:
 *   - Allow mutations if canvas_list_elements was called within 5 minutes.
 *   - OR if the target element was created in this session (tracked via
 *     context.recentlyCreatedElementIds). This lets the agent create an
 *     element and immediately fill/style/move it without re-listing.
 *   - canvas_fill_content and canvas_style_element are merge-patches
 *     (idempotent, non-destructive), so they skip the check entirely.
 */

import type { ToolUseContext } from '../../types.js';

/** Window during which a canvas_list_elements call keeps mutations fresh. */
const LIST_FRESH_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Returns true if the agent may mutate the given elementId without
 * re-calling canvas_list_elements. Callers that don't have a specific
 * elementId (e.g. batch operations) pass undefined to check only the
 * list-freshness path.
 */
export function isMutationFresh(
  context: ToolUseContext | undefined,
  elementId?: string,
): boolean {
  if (!context) return false;

  // Path 1: canvas_list_elements was called recently.
  const lastList = context.lastListElementsTime;
  if (typeof lastList === 'number' && Date.now() - lastList < LIST_FRESH_WINDOW_MS) {
    return true;
  }

  // Path 2: the target element was created in this session. The agent
  // knows the element exists because it just created it.
  if (elementId && context.recentlyCreatedElementIds?.has(elementId)) {
    return true;
  }

  return false;
}

/**
 * Build the standard STALE_STATE error result. Mention the relaxed
 * window so the agent can self-correct.
 */
export function staleStateResult(toolName: string, elementId?: string) {
  const hint = elementId
    ? `Call canvas_list_elements first, or operate on an element you just created in this session.`
    : `Call canvas_list_elements first (within the last 5 minutes).`;
  return {
    id: crypto.randomUUID(),
    name: toolName,
    result: JSON.stringify({
      success: false,
      error: {
        code: 'STALE_STATE',
        message: `Canvas state is stale. ${hint}`,
      },
    }),
    error: true,
  };
}

/**
 * Record a freshly created element in the context so subsequent
 * mutations on it bypass the list-freshness check.
 */
export function trackCreatedElement(
  context: ToolUseContext | undefined,
  elementId: string,
): void {
  if (!context) return;
  if (!context.recentlyCreatedElementIds) {
    context.recentlyCreatedElementIds = new Set<string>();
  }
  context.recentlyCreatedElementIds.add(elementId);
}
