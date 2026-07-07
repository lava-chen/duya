import type { ToolUseContext } from '../../types.js';

export interface ElementRefInput {
  elementId?: string;
  ref?: string;
}

export function resolveElementId(
  input: ElementRefInput,
  context?: ToolUseContext,
): { elementId: string } | { error: string } {
  if (input.elementId && typeof input.elementId === 'string') {
    return { elementId: input.elementId };
  }
  if (input.ref && typeof input.ref === 'string') {
    const id = context?.canvasFreshness?.refMap.get(input.ref);
    if (id) {
      return { elementId: id };
    }
    const available = [...(context?.canvasFreshness?.refMap.keys() ?? [])];
    return {
      error: `Ref "${input.ref}" not found. Available refs: ${available.join(', ') || '(none)'}. Use elementId or create the element with a ref first.`,
    };
  }
  return { error: 'Missing elementId or ref. Provide one to identify the target element.' };
}
