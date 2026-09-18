/**
 * capture-bridge.ts - IPC handler factory for conductor capture endpoints
 *
 * Plan 534 Phase 3.7.e: extracts the conductor:capture:* handlers out of
 * the monolithic electron/ipc/db-handlers.ts so the bridge logic can be
 * tested in isolation and the db-handlers.ts thin-proxy pattern stays
 * consistent with conductor:undo / conductor:redo.
 *
 * Why a factory, not just exported functions:
 * - captureWebsiteSnapshot reads project_path from conductor_canvases
 *   (a side-effect-free lookup the renderer does not own).
 * - The two handlers share a getDb() accessor that throws if the database
 *   is not initialised; injecting it lazily mirrors the createConductorUndoRedoHandlers
 *   pattern (the database may not be ready at registration time).
 *
 * Coverage (as of Phase 3.7.e):
 *   - conductor:asset:upload         -> delegate to uploadAsset (no SQL)
 *   - conductor:link:captureSnapshot -> captureWebsiteSnapshot +
 *                                       uploadProjectAsset (one SQL read)
 */

import type { IpcMainInvokeEvent } from 'electron';
import {
  uploadAsset as conductorUploadAsset,
  uploadProjectAsset as conductorUploadProjectAsset,
} from './asset-service';
import { captureWebsiteSnapshot } from './link-snapshot-service';
import type { LinkSnapshotMode } from '../../packages/conductor/src/renderer/types/canvas-node';
import type { SqliteDatabase } from '../db/core/database';

export interface CaptureHandlerDeps {
  /** Resolves the active database; throws if not initialized. */
  getDb: () => SqliteDatabase;
}

export interface ConductorAssetUploadPayload {
  canvasId: string;
  buffer: ArrayBuffer;
  fileName: string;
  mimeType?: string;
}

export interface ConductorLinkCaptureSnapshotPayload {
  canvasId: string;
  elementId: string;
  url: string;
  mode: LinkSnapshotMode;
}

/**
 * Build the conductor capture handler functions. db-handlers.ts passes
 * its internal getDb() helper so we do not duplicate the database-init
 * guard.
 */
export function createConductorCaptureHandlers(deps: CaptureHandlerDeps) {
  function upload(_event: IpcMainInvokeEvent, payload: ConductorAssetUploadPayload) {
    const { canvasId, buffer, fileName, mimeType } = payload;
    if (!canvasId || !buffer || !fileName) {
      throw new Error('canvasId, buffer, and fileName are required');
    }
    return conductorUploadAsset(canvasId, buffer, fileName, mimeType);
  }

  async function captureLinkSnapshot(
    _event: IpcMainInvokeEvent,
    payload: ConductorLinkCaptureSnapshotPayload,
  ) {
    const { canvasId, elementId, url, mode } = payload;
    if (!canvasId || !elementId || !url || !mode) {
      throw new Error('canvasId, elementId, url, and mode are required');
    }
    if (mode === 'none') {
      throw new Error('Cannot capture snapshot for mode "none"');
    }

    const normalizedUrl = /^https?:\/\//.test(url) ? url : `https://${url}`;
    const canvasRow = deps
      .getDb()
      .prepare('SELECT project_path FROM conductor_canvases WHERE id = ?')
      .get(canvasId) as { project_path: string | null } | undefined;
    const projectPath = canvasRow?.project_path ?? null;

    const capture = await captureWebsiteSnapshot(normalizedUrl, mode);
    const asset = conductorUploadProjectAsset(
      canvasId,
      projectPath,
      capture.buffer,
      `snapshot-${mode}-${Date.now()}.png`,
      'image/png',
    );

    return {
      assetId: asset.assetId,
      url: asset.url,
      width: capture.width,
      height: capture.height,
    };
  }

  return { upload, captureLinkSnapshot };
}