/**
 * recorder-handlers.ts — IPC surface for the event recorder
 * (plan 556 Phase 5, design §4.8).
 *
 * Channels (named after the `workflow:*` convention):
 *
 *   recorder:start          → start a session, show the badge
 *   recorder:stop           → stop and KEEP the session
 *   recorder:cancel         → stop and DISCARD the session
 *   recorder:status         → status snapshot (polling fallback)
 *   recorder:list-sessions  → session metadata, newest first
 *   recorder:get-session    → one session: metadata + events + dropped lines
 *   recorder:delete-session → remove a session directory
 *   recorder:convert        → events → WorkflowDef + YAML (NO write)
 *
 * `recorder:convert` deliberately does not persist anything: the
 * converter is a pure function, the user reviews the YAML, and the
 * existing `workflow:defs:create` channel performs the write — one
 * write path for definitions no matter which producer made them
 * (556 §2: plan and record converge on `validateWorkflow`).
 *
 * Main → renderer: `recorder:status-changed` carries the same snapshot
 * `recorder:status` returns, pushed on every state transition so the
 * badge / recordings view never poll.
 *
 * Logging discipline (AGENTS.md red line): captured text never reaches
 * the log — only counts and state transitions.
 */

import { ipcMain, BrowserWindow } from 'electron';

import {
  deleteSession,
  getDefaultRecorderRootDir,
  listSessions,
  loadSession,
  type RecorderEvent,
} from '@duya/computer-use';

import {
  getRecorderService,
  type RecorderStatusSnapshot,
} from '../services/recorder/service.js';
import {
  hideRecorderBadge,
  setRecorderBadgeHandlers,
  showRecorderBadge,
  updateRecorderBadge,
} from '../services/recorder/badge.js';
import { convertEventsToWorkflow } from '../../packages/agent/src/modes/workflow/converter';
import { toYaml } from '../../packages/agent/src/modes/workflow/workflow-files';
import { getLogger, LogComponent } from '../logging/logger';

const logger = getLogger();

/** Push a status snapshot to every renderer (badge is main-side only). */
function broadcastStatus(snapshot: RecorderStatusSnapshot): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send('recorder:status-changed', snapshot);
    } catch {
      // A window torn down mid-iteration is not an error.
    }
  }
}

function formatDuration(ms: number | null): string {
  if (ms === null || ms < 0) return '00:00';
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Wire the badge buttons + the status fan-out. Runs once at
 * registration; every later `showRecorderBadge` reuses the handlers.
 */
function attachBadge(): void {
  const service = getRecorderService();

  setRecorderBadgeHandlers({
    onStop: () => {
      void service.stop().then(() => hideRecorderBadge());
    },
    onCancel: () => {
      void cancelRecording();
    },
  });

  service.onStatus((snapshot) => {
    updateRecorderBadge({
      duration: formatDuration(snapshot.durationMs),
      eventCount: snapshot.eventCount,
      degraded: snapshot.degraded,
    });
    broadcastStatus(snapshot);
  });
}

/**
 * Stop the session and delete what it recorded — the badge's 取消.
 * The sessionId must be captured BEFORE stop() clears it.
 */
async function cancelRecording(): Promise<{ ok: boolean; error?: string }> {
  const service = getRecorderService();
  const sessionId = service.getSnapshot().sessionId;
  try {
    await service.stop();
    if (sessionId) {
      await deleteSession(getDefaultRecorderRootDir(), sessionId);
    }
    logger.info('recorder session discarded', undefined, LogComponent.ComputerUse);
    return { ok: true };
  } catch (err) {
    logger.error(
      'recorder cancel failed',
      err instanceof Error ? err : new Error(String(err)),
      undefined,
      LogComponent.ComputerUse,
    );
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    hideRecorderBadge();
  }
}

export function registerRecorderHandlers(): void {
  attachBadge();

  ipcMain.handle('recorder:start', async () => {
    try {
      const snapshot = await getRecorderService().start();
      showRecorderBadge();
      return { ok: true, status: snapshot };
    } catch (err) {
      logger.error(
        'recorder start failed',
        err instanceof Error ? err : new Error(String(err)),
        undefined,
        LogComponent.ComputerUse,
      );
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('recorder:stop', async () => {
    try {
      const summary = await getRecorderService().stop();
      hideRecorderBadge();
      return { ok: true, summary };
    } catch (err) {
      hideRecorderBadge();
      logger.error(
        'recorder stop failed',
        err instanceof Error ? err : new Error(String(err)),
        undefined,
        LogComponent.ComputerUse,
      );
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('recorder:cancel', () => cancelRecording());

  ipcMain.handle('recorder:status', () => getRecorderService().getSnapshot());

  ipcMain.handle('recorder:list-sessions', async () => {
    try {
      return await listSessions(getDefaultRecorderRootDir());
    } catch {
      return [];
    }
  });

  ipcMain.handle('recorder:get-session', async (_e, sessionId: string) => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
    try {
      return await loadSession(getDefaultRecorderRootDir(), sessionId);
    } catch {
      return null;
    }
  });

  ipcMain.handle('recorder:delete-session', async (_e, sessionId: string) => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return { ok: false, error: 'invalid session id' };
    }
    try {
      await deleteSession(getDefaultRecorderRootDir(), sessionId);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  /**
   * Events → WorkflowDef. Pure conversion: the caller previews the YAML
   * and saves through `workflow:defs:create`, so a failed conversion
   * can never leave a half-written definition behind.
   */
  ipcMain.handle(
    'recorder:convert',
    async (_e, payload: { sessionId: string; name?: string; description?: string }) => {
      if (!payload || typeof payload.sessionId !== 'string' || payload.sessionId.length === 0) {
        return { ok: false, error: 'invalid session id' };
      }
      try {
        const loaded = await loadSession(getDefaultRecorderRootDir(), payload.sessionId);
        const result = convertEventsToWorkflow(loaded.events as RecorderEvent[], {
          ...(payload.name ? { name: payload.name } : {}),
          ...(payload.description ? { description: payload.description } : {}),
        });
        if (!result.def) {
          return { ok: false, errors: result.errors, warnings: result.warnings };
        }
        return {
          ok: result.ok,
          def: result.def,
          // YAML is what the user reviews — the same serializer the
          // registry writes with (workflow-files.ts toYaml).
          yaml: toYaml(result.def),
          errors: result.errors,
          warnings: result.warnings,
          eventCount: loaded.events.length,
          droppedLines: loaded.dropped.length,
        };
      } catch (err) {
        logger.error(
          'recorder convert failed',
          err instanceof Error ? err : new Error(String(err)),
          undefined,
          LogComponent.ComputerUse,
        );
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
}
