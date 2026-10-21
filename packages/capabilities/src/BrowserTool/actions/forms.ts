import { z } from 'zod/v4';
import type { ActionHandler, ActionContext } from './types.js';

// ─── file_upload ──────────────────────────────────────────

const fileUploadSchema = z.object({
  selector: z.string().describe('CSS selector for file input element'),
  files: z.array(z.string()).describe('Array of absolute file paths to upload'),
});

export const fileUploadAction: ActionHandler<z.infer<typeof fileUploadSchema>> = {
  operation: 'file_upload',
  schema: fileUploadSchema,
  async execute(data, ctx) {
    if (!ctx.cdp) {
      return { error: 'File upload not available in fallback mode', mode: 'fallback' };
    }
    await ctx.cdp.setFileInput(data.files, data.selector);
    return { uploaded: data.files, selector: data.selector, mode: ctx.mode };
  },
};

// ─── select ───────────────────────────────────────────────

const selectSchema = z.object({
  ref: z.string().describe('Element ref (e.g., "@5") or CSS selector for select element'),
  value: z.string().describe('Option value to select'),
});

export const selectAction: ActionHandler<z.infer<typeof selectSchema>> = {
  operation: 'select',
  schema: selectSchema,
  async execute(data, ctx) {
    if (!ctx.cdp) {
      return { error: 'Select not available in fallback mode', mode: 'fallback' };
    }
    await ctx.cdp.selectOption(data.ref, data.value);
    return { selected: { ref: data.ref, value: data.value }, mode: ctx.mode };
  },
};
