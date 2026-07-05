// tool-result-image-metadata.ts
//
// History view: pulls browser-screenshot / vision-analyze image data
// out of a tool_result message's `attachments` array (synthetic entries
// the agent's `appendMessages` writes during persistence — see
// `promoteToolResultImagesToAttachments` in
// `packages/agent/src/session/db.ts`) and reshapes it into the
// `metadata` shape the renderer's `ScreenshotToolRow` / `VisionToolRow`
// expect.
//
// Why this indirection: the agent side has no `kind` discriminator on
// `FileAttachment`, so it stores the image as a plain
// `{ type: 'image/png', url: data:..., thumbnail: data:..., ... }` entry.
// The renderer reads those fields and mirrors them into
// `metadata.screenshot` (browser) / `metadata.imageDataUrl` (vision) so
// the existing Phase 4 row components work identically for live and
// reloaded sessions.

import type { FileAttachment, Message, ToolResultInfo } from '@/types';

interface ToolResultImageAttachment {
  type?: unknown;
  url?: unknown;
  thumbnail?: unknown;
  name?: unknown;
}

/**
 * Returns a `ToolResultInfo`-shaped metadata object that the rendering
 * rows can consume. Returns `undefined` when no image is present (so the
 * caller can leave `metadata` off the object entirely instead of
 * passing an empty `{}`).
 *
 * Browses `message.attachments` looking for the first entry whose MIME
 * is `image/*` AND whose `url` is a data URL. The metadata shape
 * matches what `BrowserTool.execute()` / `VisionTool.execute()` emit
 * during a live session.
 */
export function extractToolResultImageMetadata(msg: Message): ToolResultInfo['metadata'] {
  if (msg.role !== 'tool') return undefined;
  const attachments = msg.attachments;
  if (!Array.isArray(attachments) || attachments.length === 0) return undefined;

  const dataUrl = pickFirstImageDataUrl(attachments);
  if (!dataUrl) return undefined;

  const meta: Record<string, unknown> = {};

  const isBrowserScreenshot = typeof msg.parentToolCallId === 'string'
    && msg.toolName === 'browser';
  const isVisionAnalyze = msg.toolName === 'vision_analyze';

  if (isBrowserScreenshot) {
    meta.screenshot = dataUrl;
    return meta;
  }
  if (isVisionAnalyze) {
    const imageAtt = dataUrl.match(/^data:([^;,]+);base64,/) || null;
    meta.imageDataUrl = dataUrl;
    if (imageAtt) {
      meta.mimeType = imageAtt[1];
    }
    return meta;
  }

  // Fallback: an image attachment on an unknown tool — treat it as a
  // screenshot-shaped preview. The dedicated row components only
  // render preview when `metadata.screenshot` or `metadata.imageDataUrl`
  // matches its expected tool, so this is harmless either way.
  meta.screenshot = dataUrl;
  return meta;
}

function pickFirstImageDataUrl(attachments: FileAttachment[]): string | null {
  for (const a of attachments as unknown as ToolResultImageAttachment[]) {
    if (typeof a.type !== 'string' || !a.type.startsWith('image/')) continue;
    if (typeof a.url === 'string' && a.url.startsWith('data:image/')) return a.url;
    if (typeof a.thumbnail === 'string' && a.thumbnail.startsWith('data:image/')) return a.thumbnail;
  }
  return null;
}