/**
 * media-allowlist.ts — the single policy site for what the `duya-file://`
 * custom protocol is allowed to serve (plan 583, ISS-02).
 *
 * Background: the protocol handler in `electron/main.ts` used to
 * `readFile` whatever absolute path arrived in the URL, with no root
 * allowlist, on a scheme registered `standard` + `secure` +
 * `supportFetchAPI`. Model-authored markdown reaches that scheme —
 * `src/components/chat/markdownComponents.tsx:rewriteMediaSrc` rewrites any
 * absolute path a model writes into `duya-file:///...` — so the renderer
 * could be steered into reading arbitrary local files (config.toml,
 * secrets.json, SSH keys).
 *
 * Two independent gates, both required:
 *
 *  1. EXTENSION. Only the media types this protocol exists to serve are
 *     allowed. There is deliberately no `application/octet-stream`
 *     fallback any more: that fallback is what let `config.toml`,
 *     `secrets.json` and `id_rsa` be served with a 200.
 *  2. ROOT. The path must resolve inside one of `getMediaRoots()`. Roots
 *     are resolved with the same `isPathWithinRoots` primitive the sandboxed
 *     file tools use, so the realpath/symlink/prefix-sibling/cross-drive
 *     handling is identical rather than a third hand-rolled variant.
 *
 * Note for ISS-35: `isPathWithinRoots` currently has two other homes
 * (`packages/agent/src/tool/policy.ts` and `packages/agent/src/tool/
 * allowedRoots.ts`). This module deliberately reuses the latter via a
 * source alias rather than adding a third implementation, but the
 * consolidation into one shared helper is still open work.
 */
import path from 'node:path';
import { tmpdir } from 'node:os';
import { app } from 'electron';
import { isPathWithinRoots } from '@duya/agent/tool/allowedRoots';
import { resolveAttachmentsRoot, resolveRolloutRoot } from '../config/boot-config';

/**
 * Media types `duya-file://` may serve. The protocol exists so markdown and
 * widget output can embed images and video; it is not a general file
 * reader, so anything outside this table is refused rather than served as
 * an opaque download.
 */
const ALLOWED_MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.ogg': 'video/ogg',
  '.pdf': 'application/pdf',
};

/** Filenames that must never be served even if they carry a media extension. */
const DENIED_BASENAMES: ReadonlySet<string> = new Set(['.env', '.npmrc', '.netrc']);

/**
 * Roots that legitimately hold embeddable media.
 *
 * - attachments: user uploads and files saved by the app
 * - rollout: session transcripts and their generated artifacts
 * - tmp: scratch output from tools (the blender-screenshot case recorded in
 *   `markdownComponents.tsx` lives here)
 * - userData: packaged app data, and under it `plugins/cache` +
 *   `plugins/installed` (see `electron/plugins/cache/layout.ts`), which is
 *   where plugin icons are resolved from
 * - the app's own installation: `app:get-asset-url` serves bundled
 *   `public/icon.png` etc. through this same scheme from
 *   `app.getAppPath()` (dev) and `process.resourcesPath` (packaged), and
 *   `electron/conductor/asset-service.ts` builds conductor asset URLs here
 *   too. Without these the splash icon, plugin icons and conductor assets
 *   would 404.
 *
 * NOTE ON THE RELATIONSHIP BETWEEN THE TWO GATES: the extension gate is the
 * primary control — it is what stops `config.toml` and `secrets.json` from
 * being served at all. The root list only narrows the blast radius further.
 * That ordering is deliberate, because `app.getAppPath()` is the repo root in
 * dev, where a blanket "deny the app dir" rule would be wrong; the extension
 * gate is what keeps that root harmless (only media types are reachable).
 *
 * The duya config root is deliberately absent as a *root* — but note that
 * `attachments` and `rollout` live UNDER it, so the config root cannot be
 * denied wholesale. The sensitive files that sit beside them
 * (`config.toml`, `secrets.json`) are excluded by the extension gate, which
 * is why gate 1 is not optional.
 */
export function getMediaRoots(): string[] {
  const roots = [
    resolveAttachmentsRoot(),
    resolveRolloutRoot(),
    tmpdir(),
    app.getPath('userData'),
    app.getAppPath(),
  ];
  // Only meaningful in a packaged build; in dev this points at the Electron
  // distribution's resources dir, which is not an asset source.
  if (app.isPackaged && process.resourcesPath) roots.push(process.resourcesPath);
  return roots.filter((root) => typeof root === 'string' && root.length > 0);
}

export type MediaDecision =
  | { allowed: true; mimeType: string }
  | { allowed: false; reason: 'bad-extension' | 'denied-name' | 'outside-roots' | 'not-absolute' };

/**
 * Decide whether `filePath` may be served over `duya-file://`.
 *
 * `filePath` is expected to already be normalised to an absolute native
 * path (the protocol handler does the drive-letter recovery before calling).
 */
export function checkMediaPath(filePath: string): MediaDecision {
  if (!filePath || !path.isAbsolute(filePath)) {
    return { allowed: false, reason: 'not-absolute' };
  }

  const ext = path.extname(filePath).toLowerCase();
  const mimeType = ALLOWED_MEDIA_TYPES[ext];
  if (!mimeType) {
    return { allowed: false, reason: 'bad-extension' };
  }

  const basename = path.basename(filePath).toLowerCase();
  if (DENIED_BASENAMES.has(basename)) {
    return { allowed: false, reason: 'denied-name' };
  }

  if (!isPathWithinRoots(filePath, getMediaRoots())) {
    return { allowed: false, reason: 'outside-roots' };
  }

  return { allowed: true, mimeType };
}
