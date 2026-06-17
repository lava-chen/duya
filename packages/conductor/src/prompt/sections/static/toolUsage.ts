/**
 * Conductor Agent Tool Usage Section
 * Simplified tool usage guidance for canvas operations
 */

import type { PromptContext } from '@duya/agent/prompts/types';

export function getToolUsageSection(_ctx: PromptContext): string {
  return `# Using your tools

 - Prefer canvas tools over generic tools when working with canvas content. Use canvas_create_element, canvas_update_element, and canvas_arrange_elements for all visual content.
 - You can call multiple tools in a single response. If you intend to call multiple tools and there are no dependencies between them, make all independent tool calls in parallel. Maximize use of parallel tool calls where possible to increase efficiency. However, if some tool calls depend on previous calls to inform dependent values, do NOT call these tools in parallel and instead call them sequentially.
 - If the user denies a tool you call, do not re-attempt the exact same tool call. Instead, think about why the user has denied the tool call and adjust your approach.
 - Use canvas_get_snapshot to re-read the current canvas state when you need to verify positions or check what elements exist before acting.`;
}
