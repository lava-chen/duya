/**
 * Conductor Refine — strict-JSON response schema.
 *
 * The renderer validates the LLM response with this zod schema before
 * applying it via `widget.update_data`.
 */

import { z } from "zod";

export const RefineLlmResponseSchema = z.object({
  done: z.boolean(),
  rationale: z.string().max(500),
  data: z.record(z.string(), z.unknown()),
  warnings: z.array(z.string()).default([]),
});

export type RefineLlmResponseParsed = z.infer<typeof RefineLlmResponseSchema>;

/**
 * Parse raw LLM output text into a validated response object.
 * Tolerant of leading/trailing whitespace and ```json fences.
 */
export function parseRefineLlmResponse(raw: string): RefineLlmResponseParsed {
  let text = raw.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  }
  const parsed = JSON.parse(text);
  return RefineLlmResponseSchema.parse(parsed);
}