/**
 * decode-message-attachments.ts - Plan 220 Phase 3.
 *
 * Read-side adapter that takes a `Message` (potentially with the legacy
 * `<pasted-content>` marker format) and returns the modern shape:
 * a clean text body and a unified `FileAttachment[]` array.
 *
 * This is the ONLY place in the renderer that still understands the
 * legacy marker format. New messages never hit it because the write
 * path no longer emits markers. A future plan can drop this module
 * once enough time has passed for legacy rows to age out.
 *
 * The adapter:
 *   1. If `content` contains no `<pasted-content>` markers, returns
 *      `{ text: content, attachments: inputAttachments }` unchanged.
 *   2. If markers are present, parses them via the existing
 *      `parseMessageContentWithPasted` decoder, synthesizes
 *      `kind: 'pasted-text'` attachments for each marker, and merges
 *      those with the input attachments array.
 *   3. The returned `text` has the markers stripped.
 *
 * Browser-reference markers (`[[duya-browser-ref:...]]`) are also
 * extracted from the text and surfaced as `kind: 'browser-ref'`
 * attachments. This codifies what `MessageItem.tsx` was already doing
 * inline in `userBrowserReferences`.
 */

import type { FileAttachment } from '@/types/message';
import {
  parseMessageContentWithPasted,
  type PastedContentInfo,
} from './message-content-parser';
import {
  parseBrowserReferenceDisplayContent,
  type BrowserReferenceDisplayData,
} from './browser-reference-display';

export interface DecodedMessage {
  /** Clean text body, with all markers stripped. */
  text: string;
  /**
   * Unified FileAttachment list. Always includes any input attachments
   * plus synthesized entries for legacy markers found in `content`.
   */
  attachments: FileAttachment[];
}

function pastedInfoToAttachment(info: PastedContentInfo): FileAttachment {
  return {
    id: info.id,
    kind: 'pasted-text',
    name: info.preview,
    type: 'text/plain',
    url: '',
    size: info.fullContent.length,
    text: info.fullContent,
    previewText: info.preview,
    metadata: { timestamp: 0 },
  };
}

function browserRefToAttachment(
  ref: BrowserReferenceDisplayData,
  index: number,
): FileAttachment {
  // The browser-ref display shape carries the formatted "Browser element
  // reference" / "Browser screenshot reference" block as `content`.
  // That text becomes the model-facing `text` of the attachment.
  return {
    id: `legacy-browser-ref-${index}-${Date.now()}`,
    kind: 'browser-ref',
    name: ref.label || ref.title || 'Browser reference',
    type: 'text/plain',
    url: '',
    size: ref.content.length,
    text: ref.content,
    previewText: ref.title || ref.label || 'Browser reference',
    metadata: {
      url: ref.url,
      elementKind: ref.kind,
      title: ref.title,
    },
  };
}

/**
 * Decode a Message's text + attachments. If `content` contains legacy
 * markers, they are promoted to typed attachments and stripped from the
 * returned text.
 */
export function decodeMessageAttachments(
  content: string,
  inputAttachments: FileAttachment[] | null | undefined,
): DecodedMessage {
  const safeAttachments = inputAttachments ?? [];
  let text = content;

  // 1. Pasted-content markers.
  if (text.includes('<pasted-content id="')) {
    const parsed = parseMessageContentWithPasted(text);
    text = parsed.text;
    const synthesized = parsed.pastedContents.map(pastedInfoToAttachment);
    return {
      text,
      attachments: [...safeAttachments, ...synthesized],
    };
  }

  // 2. Browser-ref markers (older format; may be in the same content).
  if (text.includes('[[duya-browser-ref:')) {
    const parsed = parseBrowserReferenceDisplayContent(text);
    const synthesized = parsed.references.map(browserRefToAttachment);
    return {
      text: parsed.text,
      attachments: [...safeAttachments, ...synthesized],
    };
  }

  return { text, attachments: safeAttachments };
}