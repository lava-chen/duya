import type { MessageContent } from '@duya/agent-core/message';
import { isCDNImageUrl } from '@duya/capabilities/utils/urlSafety';

export interface ImageAttachmentPayloadRow {
  readonly mime_type: string | null;
  readonly data: string;
  readonly original_url: string | null;
}

export interface ImageRehydrationLogger {
  warn(message: string, context?: Record<string, unknown>, component?: string): void;
}

/** Replace persisted provider CDN image URLs with their local base64 payloads. */
export function rehydrateContentWithAttachments(
  content: string | MessageContent[],
  attachmentMap: ReadonlyMap<string, readonly ImageAttachmentPayloadRow[]>,
  logger?: ImageRehydrationLogger,
): string | MessageContent[] {
  if (typeof content === 'string' || !Array.isArray(content)) return content;

  const results: MessageContent[] = [];
  let needsRehydration = false;

  for (const block of content) {
    if (block.type !== 'image') {
      results.push(block);
      continue;
    }

    const source = block.source as typeof block.source & { readonly url?: string };
    const url = source.url || source.data;
    if (source.type !== 'url' || !url || !isCDNImageUrl(url)) {
      results.push(block);
      continue;
    }

    needsRehydration = true;
    let attachment: ImageAttachmentPayloadRow | undefined;
    for (const attachments of attachmentMap.values()) {
      attachment = attachments.find((candidate) =>
        candidate.original_url !== null &&
        (candidate.original_url === url || url.includes(candidate.original_url)),
      );
      if (attachment) break;
    }

    if (!attachment) {
      logger?.warn('No attachment found for CDN URL; skipping image block', { url }, 'DB');
      continue;
    }

    results.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: attachment.mime_type ?? 'image/png',
        data: attachment.data,
      },
    });
  }

  return needsRehydration ? results : content;
}
