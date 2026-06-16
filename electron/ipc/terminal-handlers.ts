/**
 * electron/ipc/terminal-handlers.ts
 *
 * IPC surface for the sidebar terminal panel.
 *
 * Channels (renderer -> main, invoke):
 *   - terminal:spawn  ({ id?, shell?, cwd?, cols?, rows? }) -> { handle, scrollback }
 *   - terminal:list   ()                      -> { terminals }
 *   - terminal:snapshot ({ id })              -> { snapshot }
 *   - terminal:write  ({ id, data })         -> { ok }
 *   - terminal:resize ({ id, cols, rows })   -> { ok }
 *   - terminal:kill   ({ id })               -> { ok }
 *   - terminal:suggest ({ prefix, shell?, cwd? }) -> { suggestions }
 *
 * Channels (main -> renderer, event):
 *   - terminal:output ({ id, data })
 *   - terminal:exit   ({ id, code })
 */

import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { getMainWindow } from '../core/window-manager';
import {
  getTerminalManager,
  newTerminalId,
  type TerminalShell,
  type TerminalSnapshot,
} from '../services/terminal';
import { getLogger, LogComponent } from '../logging/logger';

const logger = getLogger();

const SHELLS: readonly TerminalShell[] = ['powershell', 'pwsh', 'bash', 'zsh', 'fish', 'sh', 'cmd'];

function isShell(v: unknown): v is TerminalShell {
  return typeof v === 'string' && (SHELLS as readonly string[]).includes(v);
}

interface SpawnPayload {
  id?: unknown;
  shell?: unknown;
  cwd?: unknown;
  env?: unknown;
  cols?: unknown;
  rows?: unknown;
  title?: unknown;
}

interface WritePayload {
  id?: unknown;
  data?: unknown;
}

interface ResizePayload {
  id?: unknown;
  cols?: unknown;
  rows?: unknown;
}

interface KillPayload {
  id?: unknown;
}

interface SuggestPayload {
  prefix?: unknown;
  shell?: unknown;
  cwd?: unknown;
  limit?: unknown;
}

interface RecordPayload {
  command?: unknown;
  shell?: unknown;
  cwd?: unknown;
  source?: unknown;
}

function sendToRenderer(channel: string, payload: unknown): void {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return;
  win.webContents.send(channel, payload);
}

export function registerTerminalHandlers(): void {
  const manager = getTerminalManager();

  // Forward manager events to the renderer. Subscribed exactly once
  // per registration; safe to call again only if no listeners exist.
  let subscribed = false;
  const ensureSubscription = (): void => {
    if (subscribed) return;
    subscribed = true;
    manager.subscribe((event) => {
      if (event.type === 'output') {
        sendToRenderer('terminal:output', event.payload);
      } else {
        sendToRenderer('terminal:exit', event.payload);
      }
    });
  };
  ensureSubscription();

  ipcMain.handle(
    'terminal:spawn',
    (_event: IpcMainInvokeEvent, payload: SpawnPayload | undefined) => {
      ensureSubscription();
      const shell = payload && isShell(payload.shell) ? payload.shell : undefined;
      const cwd = payload && typeof payload.cwd === 'string' && payload.cwd.length > 0
        ? payload.cwd
        : undefined;
      const id = payload && typeof payload.id === 'string' && payload.id.length > 0
        ? payload.id
        : newTerminalId();
      const env = payload && payload.env && typeof payload.env === 'object'
        ? (payload.env as Record<string, string>)
        : undefined;
      const cols = payload && typeof payload.cols === 'number' ? payload.cols : undefined;
      const rows = payload && typeof payload.rows === 'number' ? payload.rows : undefined;
      const title = payload && typeof payload.title === 'string' ? payload.title : undefined;

      try {
        const snapshot: TerminalSnapshot = manager.spawn({ id, shell, cwd, env, cols, rows, title });
        return { ok: true, handle: snapshot.handle, scrollback: snapshot.scrollback };
      } catch (err) {
        // Be defensive about `err`: spawn() can throw a plain string or
        // an object without a `.message`. `String(err)` always produces
        // something readable, and we surface the error name + code when
        // available so future "Error: undefined" mysteries are debuggable.
        const message = err instanceof Error
          ? (err.message || err.name || 'spawn failed')
          : typeof err === 'string'
            ? err
            : String(err) || 'spawn failed';
        const detail = err instanceof Error
          ? { name: err.name, code: (err as NodeJS.ErrnoException).code }
          : { raw: String(err) };
        logger.error('terminal:spawn failed', { id, error: message, ...detail }, LogComponent.Main);
        return { ok: false, error: message };
      }
    }
  );

  ipcMain.handle('terminal:list', () => {
    return { ok: true, terminals: manager.list() };
  });

  ipcMain.handle(
    'terminal:snapshot',
    (_event: IpcMainInvokeEvent, payload: KillPayload | undefined) => {
      if (!payload || typeof payload.id !== 'string') {
        return { ok: false, error: 'invalid payload' };
      }
      const snapshot = manager.getSnapshot(payload.id);
      return snapshot ? { ok: true, snapshot } : { ok: false, error: 'terminal not found' };
    }
  );

  ipcMain.handle(
    'terminal:write',
    (_event: IpcMainInvokeEvent, payload: WritePayload | undefined) => {
      if (!payload || typeof payload.id !== 'string' || typeof payload.data !== 'string') {
        return { ok: false, error: 'invalid payload' };
      }
      try {
        const ok = manager.write(payload.id, payload.data);
        return { ok };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn('terminal:write threw', { id: payload.id, error: message }, LogComponent.Main);
        return { ok: false, error: message };
      }
    }
  );

  ipcMain.handle(
    'terminal:resize',
    (_event: IpcMainInvokeEvent, payload: ResizePayload | undefined) => {
      if (!payload || typeof payload.id !== 'string') {
        return { ok: false, error: 'invalid payload' };
      }
      const cols = typeof payload.cols === 'number' && payload.cols > 0 ? payload.cols : 80;
      const rows = typeof payload.rows === 'number' && payload.rows > 0 ? payload.rows : 24;
      return { ok: manager.resize(payload.id, cols, rows) };
    }
  );

  ipcMain.handle(
    'terminal:kill',
    (_event: IpcMainInvokeEvent, payload: KillPayload | undefined) => {
      if (!payload || typeof payload.id !== 'string') {
        return { ok: false, error: 'invalid payload' };
      }
      try {
        return { ok: manager.kill(payload.id) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn('terminal:kill threw', { id: payload.id, error: message }, LogComponent.Main);
        return { ok: false, error: message };
      }
    }
  );

  ipcMain.handle(
    'terminal:suggest',
    (_event: IpcMainInvokeEvent, payload: SuggestPayload | undefined) => {
      if (!payload || typeof payload.prefix !== 'string') {
        return { ok: false, error: 'invalid payload', suggestions: [] };
      }
      const shell = isShell(payload.shell) ? payload.shell : undefined;
      const cwd = typeof payload.cwd === 'string' && payload.cwd.length > 0 ? payload.cwd : undefined;
      const limit = typeof payload.limit === 'number' ? payload.limit : undefined;
      return { ok: true, suggestions: manager.suggest(payload.prefix, shell, cwd, limit) };
    }
  );

  ipcMain.handle(
    'terminal:record',
    (_event: IpcMainInvokeEvent, payload: RecordPayload | undefined) => {
      if (
        !payload ||
        typeof payload.command !== 'string' ||
        !isShell(payload.shell) ||
        typeof payload.cwd !== 'string'
      ) {
        return { ok: false, error: 'invalid payload' };
      }
      const source = typeof payload.source === 'string' ? payload.source : 'user';
      manager.recordCommand(payload.command, payload.shell, payload.cwd, source);
      return { ok: true };
    }
  );

  logger.info('Terminal IPC handlers registered', undefined, LogComponent.Main);
}
