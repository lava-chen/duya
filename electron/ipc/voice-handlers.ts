/**
 * ipc/voice-handlers.ts — voice:* IPC handlers (Renderer ⇄ Main).
 *
 * Thin adapter over VoiceService. Enforces input validation (chunk typed +
 * bounded at 64 KiB) and forwards voice events to every live renderer window.
 */
import { BrowserWindow, ipcMain } from 'electron';
import { createVoiceService, type VoiceService } from '../services/voice';
import { getLogger, LogComponent } from '../logging/logger';

const MAX_CHUNK_BYTES = 64 * 1024;

let service: VoiceService | null = null;
let registered = false;

function getService(): VoiceService {
  if (!service) {
    service = createVoiceService({
      emit: (channel, payload) => {
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) win.webContents.send(channel, payload);
        }
      },
    });
  }
  return service;
}

export function registerVoiceHandlers(): void {
  if (registered) return;
  registered = true;
  const logger = getLogger();

  ipcMain.handle('voice:start', async (_event, opts?: { sessionId?: string }) => {
    logger.info('voice:start', { sessionId: opts?.sessionId }, LogComponent.Voice);
    return getService().start(opts);
  });

  ipcMain.handle('voice:transcribe-chunk', (_event, raw: unknown) => {
    if (!(raw instanceof Int16Array) && !ArrayBuffer.isView(raw)) {
      return { ok: false, error: 'invalid chunk' };
    }
    const chunk =
      raw instanceof Int16Array ? raw : new Int16Array((raw as ArrayBufferView).buffer);
    if (chunk.byteLength > MAX_CHUNK_BYTES) {
      return { ok: false, error: 'chunk too large' };
    }
    return getService().transcribeChunk(chunk);
  });

  ipcMain.handle('voice:stop', async (_event) => {
    return getService().stop();
  });

  ipcMain.handle('voice:cancel', async (_event) => {
    return getService().cancel();
  });

  ipcMain.handle('voice:config', () => {
    return getService().getConfig();
  });

  ipcMain.handle('voice:model-status', () => {
    return getService().getModelStatus();
  });

  ipcMain.handle('voice:model-list', () => {
    return getService().getModelList();
  });

  ipcMain.handle('voice:env-doctor', () => {
    return getService().envReport();
  });
}