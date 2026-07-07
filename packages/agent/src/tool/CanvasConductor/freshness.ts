/**
 * Freshness check for canvas mutation tools.
 *
 * Policy:
 *   - Allow mutations if canvas_list_elements was called within 5 minutes.
 *   - OR if the target element was created in this session (tracked via
 *     canvasFreshness.recentlyCreatedElementIds). This lets the agent
 *     create an element and immediately fill/style/move it without
 *     re-listing.
 *
 * All mutable state lives on `context.canvasFreshness` (a stable reference
 * object) rather than directly on `context`. StreamingToolExecutor spreads
 * ToolUseContext per tool call, so writing to `context.lastListElementsTime`
 * would land on a throwaway copy. Writing to `context.canvasFreshness.xxx`
 * works because the spread copies the reference, not the underlying object.
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
  const state = context?.canvasFreshness;
  if (!state) return false;

  // Path 1: canvas_list_elements was called recently.
  const lastList = state.lastListElementsTime;
  if (typeof lastList === 'number' && Date.now() - lastList < LIST_FRESH_WINDOW_MS) {
    return true;
  }

  // Path 2: the target element was created in this session. The agent
  // knows the element exists because it just created it.
  if (elementId && state.recentlyCreatedElementIds.has(elementId)) {
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
 * Record a freshly created element in the shared freshness state so
 * subsequent mutations on it bypass the list-freshness check. No-op if
 * the context has no canvasFreshness container (defensive — DuyaAgent
 * initializes it whenever conductor mode is active).
 */
export function trackCreatedElement(
  context: ToolUseContext | undefined,
  elementId: string,
): void {
  context?.canvasFreshness?.recentlyCreatedElementIds.add(elementId);
}
