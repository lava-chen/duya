/**
 * packages/ai/src/utils/tool-order.ts
 *
 * Deterministic tool ordering for prompt-cache stability.
 *
 * Tool definitions are the largest stable prefix of the request prompt. MCP
 * tools arrive in connection order, which is not stable across sessions — an
 * order change invalidates the entire prompt cache and forces a full cache
 * write. Sorting by name fixes the order for every provider. `tool_choice`
 * references tools by name, so reordering never changes semantics.
 */

/**
 * Sort tools by name (locale-independent byte order) for a deterministic
 * request prefix. Returns a new array; the input is not mutated.
 */
export function sortToolsByName<T extends { name: string }>(tools: readonly T[]): T[] {
  return [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
