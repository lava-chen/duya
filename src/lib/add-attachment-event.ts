/**
 * add-attachment-event.ts - Plan 220 Phase 4 + Phase 6.
 *
 * Single dispatch helper for adding an attachment to the chat input.
 * Replaces the three legacy `*-add-to-input` events
 * (`file-tree-add-to-input`, `terminal-add-to-input`, `browser-add-to-input`)
 * with one `duya:add-attachment` event whose `detail` carries a tagged
 * union identifying the attachment kind.
 *
 * Usage (from a panel):
 *
 *   dispatchAddAttachment({ kind: 'terminal-ref', shell, cwd, text });
 *   dispatchAddAttachment({ kind: 'browser-ref', reference: {...}, attachment });
 *
 * The `MessageInput` listener picks up the detail and calls into
 * `useAttachments` to add the right kind of attachment.
 *
 * The legacy event names remain dispatched (Plan 220 §Design: kept as
 * deprecation aliases for one minor version). When a legacy event
 * arrives at `MessageInput`, the listener translates it into the same
 * `dispatchAddAttachment(...)` call shape so panels can migrate
 * independently.
 */

import type { FileAttachment, AttachmentMetadata } from '@/types/message';

export type BrowserReferencePayload = {
  kind: 'element' | 'screenshot';
  label: string;
  title: string;
  url: string;
  /** Formatted "Browser element reference: ..." or "Browser screenshot reference: ..." block. */
  content: string;
  /** For screenshots, the paired FileAttachment carrying the PNG bytes. */
  attachment?: FileAttachment;
};

export type AddAttachmentDetail =
  | { kind: 'file'; file: FileAttachment }
  | { kind: 'pasted-text'; text: string; preview?: string }
  | {
      kind: 'terminal-ref';
      shell: string;
      cwd: string;
      text: string;
    }
  | {
      kind: 'browser-ref';
      reference: BrowserReferencePayload;
      attachment?: FileAttachment;
    }
  | { kind: 'file-tree-ref'; path: string; lineStart?: number; lineEnd?: number; selectedText?: string };

export const ADD_ATTACHMENT_EVENT = 'duya:add-attachment';

export function dispatchAddAttachment(detail: AddAttachmentDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(ADD_ATTACHMENT_EVENT, { detail }));
}

/**
 * Re-export so callers can read the AttachmentMetadata union without
 * reaching into the message type module directly. Avoids a deep import
 * path at the call sites.
 */
export type { FileAttachment, AttachmentMetadata };