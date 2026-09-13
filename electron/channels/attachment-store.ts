/**
 * attachment-store.ts — stable persistence for inbound channel attachments
 * (plan 507 P1.2).
 *
 * Layout (plan 526 shared root, mirrors the 485 `agents/<id>/` convention):
 *   ~/.duya/agents/<ownerId>/attachments/inbound/<platform>/
 *     <yyyyMMdd_HHmmss_SSS>_<safeName>
 *
 * Why: adapters download media to OS temp caches (evicted on reboot); the
 * wake prompt points the bot at a file path, so the copy must survive
 * restarts. Writes are atomic (tmp + rename), mirroring channel-store.ts.
 *
 * Size limits mirror packages/gateway/src/attachment-builder.ts so behavior
 * is uniform across the gateway route path and the per-bot connector path.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { EXT_MIME_MAP } from '../../packages/gateway/src/utils/mime';
import type { ChannelInboundAttachment } from '../../packages/agent/src/channels/types';
import { getSharedAgentsRoot } from '../config/agent-paths';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_DOC_BYTES = 20 * 1024 * 1024;
const MAX_AUDIO_VIDEO_BYTES = 25 * 1024 * 1024;

/** Persisted-source attachment: either an existing temp file or raw bytes. */
export type AttachmentSource =
  | { readonly kind: 'path'; readonly path: string }
  | { readonly kind: 'buffer'; readonly buffer: Buffer };

/** Reject identifiers that could escape the agents/<id>/ directory. */
function assertSafeSegment(label: string, value: string): void {
  if (
    !value ||
    value.includes(path.sep) ||
    value.includes('/') ||
    value.includes('..') ||
    value.includes('\0')
  ) {
    throw new Error(`attachment-store: invalid ${label}: "${value}"`);
  }
}

/** Keep a platform file name safe as a single path segment. */
export function sanitizeFileName(name: string): string {
  // Collapse dot-runs first so `..` can never survive as a traversal token.
  const cleaned = name
    .replace(/\.{2,}/g, '_')
    .replace(/[^\w.\- ]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned.slice(0, 120) || 'file';
}

/** Coarse attachment kind from a MIME type (plan 507 §4). */
export function attachmentKindOf(mimeType: string): ChannelInboundAttachment['kind'] {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  return 'document';
}

function maxBytesFor(kind: ChannelInboundAttachment['kind']): number {
  if (kind === 'image') return MAX_IMAGE_BYTES;
  if (kind === 'audio' || kind === 'video') return MAX_AUDIO_VIDEO_BYTES;
  return MAX_DOC_BYTES;
}

function resolveMime(name: string): string {
  const ext = path.extname(name).toLowerCase();
  return EXT_MIME_MAP[ext] ?? 'application/octet-stream';
}

function timestampName(): string {
  const d = new Date();
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}_${p(d.getMilliseconds(), 3)}`;
}

/** Resolve the inbound attachment directory for an owner + platform. */
export function inboundAttachmentDir(ownerId: string, platform: string): string {
  assertSafeSegment('ownerId', ownerId);
  assertSafeSegment('platform', platform);
  return path.join(getSharedAgentsRoot(), ownerId, 'attachments', 'inbound', platform);
}

export interface PersistResult {
  /** Persisted attachment record, or null when skipped (e.g. too large). */
  attachment: ChannelInboundAttachment | null;
  /** Non-empty when the attachment was skipped; explains why. */
  skippedReason?: string;
}

/**
 * Persist an inbound attachment to a stable path. Never throws for expected
 * conditions (oversize, unreadable source) — returns a skipped reason so the
 * caller can surface `[attachment skipped: ...]` in the wake prompt. Only
 * invalid identifiers throw (programmer error).
 */
export async function persistInboundAttachment(
  ownerId: string,
  platform: string,
  source: AttachmentSource,
  name: string,
): Promise<PersistResult> {
  assertSafeSegment('ownerId', ownerId);
  assertSafeSegment('platform', platform);

  const safeName = sanitizeFileName(name);
  const mimeType = resolveMime(safeName);
  const kind = attachmentKindOf(mimeType);
  const maxBytes = maxBytesFor(kind);

  let bytes: Buffer;
  try {
    bytes =
      source.kind === 'buffer'
        ? source.buffer
        : await fs.promises.readFile(source.path);
  } catch {
    return { attachment: null, skippedReason: `could not read source for ${safeName}` };
  }

  if (bytes.length === 0) {
    return { attachment: null, skippedReason: `${safeName} is empty` };
  }
  if (bytes.length > maxBytes) {
    const mb = (maxBytes / (1024 * 1024)).toFixed(0);
    return { attachment: null, skippedReason: `${safeName} exceeds the ${mb} MB limit` };
  }

  const dir = inboundAttachmentDir(ownerId, platform);
  await fs.promises.mkdir(dir, { recursive: true });

  const dest = path.join(dir, `${timestampName()}_${safeName}`);
  const tmp = `${dest}.tmp.${Date.now()}`;
  await fs.promises.writeFile(tmp, bytes);
  await fs.promises.rename(tmp, dest);

  return {
    attachment: { name: safeName, path: dest, mimeType, size: bytes.length, kind },
  };
}

/**
 * Persist a batch, preserving order. Convenience wrapper used by the
 * connectors and the message-bus gateway route path.
 */
export async function persistInboundAttachments(
  ownerId: string,
  platform: string,
  entries: ReadonlyArray<{ source: AttachmentSource; name: string }>,
): Promise<PersistResult[]> {
  const results: PersistResult[] = [];
  for (const entry of entries) {
    // Sequential: one failure must not abort the remaining attachments.
    results.push(await persistInboundAttachment(ownerId, platform, entry.source, entry.name));
  }
  return results;
}
