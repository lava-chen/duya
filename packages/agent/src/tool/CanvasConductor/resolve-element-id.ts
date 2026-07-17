export interface ElementRefInput {
  elementId?: string;
}

export function resolveElementId(
  input: ElementRefInput,
): { elementId: string } | { error: string } {
  if (input.elementId && typeof input.elementId === 'string') {
    return { elementId: input.elementId };
  }
  return { error: 'Missing elementId. Provide the target element ID.' };
}
