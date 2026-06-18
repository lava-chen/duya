import { z } from 'zod';
import type { ElementKind } from './conductor';

// Native element types manage their own vizSpec internally; widget payloads
// are free-form. This file used to define per-element-kind schemas for the
// removed kinds (diagram, chart, content/card, content/rich-text, content/image,
// shape, app/mini-app); those have been deleted along with the kinds.

// === Discriminated payload union ===
// Kept as an empty union — native/widget elements use Record<string, unknown>.
// Existing callers can still import the type as a no-op.
export type VizSpecPayload = never;

export function getPayloadSchema(kind: ElementKind): z.ZodTypeAny {
  return z.record(z.string(), z.unknown());
}
