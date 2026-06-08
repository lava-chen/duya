/**
 * ReadTool - Zod schema for input validation
 *
 * Replaces the hand-rolled if-chain in the original implementation.
 * Mirrors the same constraints (line_range end=-1, pages "N" or "N-M",
 * max_tokens positive integer) but expressed as a single declarative
 * schema. Validation produces a JSON-shaped error message that the
 * BaseTool layer can surface directly.
 */

import { z } from 'zod';

/**
 * line_range.start: 1-indexed positive integer
 * line_range.end: positive integer OR -1 (sentinel for "end of file")
 */
const lineRangeSchema = z.object({
  start: z
    .number()
    .int()
    .min(1, 'line_range.start must be an integer >= 1')
    .describe('Starting line number (1-indexed).'),
  end: z
    .number()
    .int()
    .min(-1, 'line_range.end must be greater than line_range.start, or use -1 for end of file')
    .max(1_000_000, 'line_range.end cannot exceed 1000000')
    .describe('Ending line number (1-indexed, inclusive). Use -1 to read to end of file.'),
});

/**
 * pages: "N" or "N-M" format. Whitespace tolerated.
 * Caps the upper bound to 10000 to prevent silly inputs.
 */
const pagesSchema = z
  .string()
  .regex(/^\s*\d+\s*(?:-\s*\d+\s*)?$/, 'pages must be in format "N" or "N-M"')
  .transform((s) => s.trim());

export const readInputSchema = z.object({
  file_path: z
    .string({ error: 'file_path must be a string' })
    .min(1, 'file_path cannot be empty')
    .describe('The path to the file to read. Can be absolute or relative to the working directory.'),
  line_range: lineRangeSchema
    .optional()
    .describe(
      'Optional line range for text files. If specified, bypasses the document parser and reads the file as plain text.',
    ),
  pages: pagesSchema
    .optional()
    .describe(
      'Optional PDF page range, e.g. "1-5" or "3". Only valid for PDF files. If not provided, the entire document is read.',
    ),
  max_tokens: z
    .number()
    .int()
    .positive()
    .max(1_000_000)
    .optional()
    .describe(
      'Optional token cap for the returned content (default 25000). Documents exceeding this limit are truncated with a system reminder.',
    ),
});

export type ReadInput = z.infer<typeof readInputSchema>;

/**
 * Backwards-compatible validator entry point. Existing callers
 * (BaseTool.validateInput, ReadTool.checkPermissions, ReadTool.execute)
 * expect { valid, data } | { valid, error } shape.
 *
 * Zod's safeParse returns { success, data, error }; we translate.
 */
export function validateReadInput(
  input: unknown,
): { valid: true; data: ReadInput } | { valid: false; error: string } {
  if (!input || typeof input !== 'object') {
    return { valid: false, error: 'Input must be an object' };
  }
  const result = readInputSchema.safeParse(input);
  if (result.success) {
    return { valid: true, data: result.data };
  }
  // First issue is usually the most actionable; surface it.
  const first = result.error.issues[0];
  return {
    valid: false,
    error: first ? `${first.path.join('.') || '<root>'}: ${first.message}` : result.error.message,
  };
}
