/**
 * post — unified social-media post action for multiple platforms.
 *
 * Dispatches to the appropriate platform-specific implementation based on
 * the `platform` parameter. Currently supports:
 *   - "x" / "twitter"  → Twitter/X.com via browser UI automation
 *   - "weibo"          → Sina Weibo (placeholder, needs implementation)
 *   - "linkedin"       → LinkedIn (placeholder, needs implementation)
 *
 * Prerequisite for Twitter: an active logged-in browser session on x.com.
 *
 * Posting publishes publicly. The model should obtain explicit user
 * confirmation before calling this action.
 */

import { z } from 'zod/v4';
import type { ActionHandler, ActionContext } from './types.js';
import { postOnTwitter } from './twitterPost.js';

// ─── Platform registry ──────────────────────────────────────────────────

/** Platform-agnostic options shared by every handler. */
export interface PostOptions {
  /** When set, publish as a reply to this tweet (full status URL or numeric id). */
  replyTo?: string;
}

interface PlatformHandler {
  name: string;
  execute(
    text: string,
    images: string[],
    ctx: ActionContext,
    options: PostOptions
  ): Promise<{ status?: string; message?: string; text?: string; id?: string; url?: string; replyTo?: string; error?: string; warning?: string; mode?: string }>;
}

const PLATFORM_HANDLERS: Record<string, PlatformHandler> = {
  x: {
    name: 'X (Twitter)',
    execute: postOnTwitter,
  },
  twitter: {
    name: 'X (Twitter)',
    execute: postOnTwitter,
  },
  weibo: {
    name: 'Sina Weibo',
    execute: async (_text, _images, ctx) => ({
      error: 'Weibo posting is not yet implemented. Track progress in the related exec plan.',
      warning: 'This platform requires implementation. Use navigate + click + type to post manually in the meantime.',
      mode: ctx.mode,
    }),
  },
  linkedin: {
    name: 'LinkedIn',
    execute: async (_text, _images, ctx) => ({
      error: 'LinkedIn posting is not yet implemented. Track progress in the related exec plan.',
      warning: 'This platform requires implementation. Use navigate + click + type to post manually in the meantime.',
      mode: ctx.mode,
    }),
  },
};

// ─── Schema ─────────────────────────────────────────────────────────────

const postSchema = z.object({
  platform: z
    .enum(['x', 'twitter', 'weibo', 'linkedin'])
    .describe('Target platform: "x" or "twitter" (X.com), "weibo" (Sina Weibo), "linkedin"'),
  text: z.string().describe('Text content to publish'),
  images: z
    .array(z.string())
    .optional()
    .default([])
    .describe('Absolute paths to images to attach (max 4 for Twitter; platform-specific for others)'),
  replyTo: z
    .string()
    .optional()
    .describe('When set, publish as a reply to this tweet (full status URL or numeric id)'),
});

export type PostSchema = z.infer<typeof postSchema>;

// ─── Action ─────────────────────────────────────────────────────────────

export const postAction: ActionHandler<PostSchema> = {
  operation: 'post',
  // Deliberately hidden: posting is an irreversible public write action.
  // The model learns it is available from the capability guide rather than
  // from a self-advertising schema entry.
  hidden: true,
  schema: postSchema,
  async execute(data, ctx) {
    const { platform, text, images = [], replyTo } = data;

    const handler = PLATFORM_HANDLERS[platform];
    if (!handler) {
      return {
        error: `Unsupported platform "${platform}". Supported: ${Object.keys(PLATFORM_HANDLERS).join(', ')}`,
        mode: ctx.mode,
      };
    }

    // Delegate to the platform-specific handler and stamp the platform onto
    // the result so the formatter can label it consistently.
    const result = await handler.execute(text, images, ctx, { replyTo });
    return { ...result, platform, mode: result.mode ?? ctx.mode };
  },
};
