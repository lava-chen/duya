/**
 * session-card-handlers.ts — Renderer IPC for the live "child session" card
 * (plan 504 UI). Backs the `session` tool's spawn card shown in the bot chat.
 *
 * Unlike the agent-facing db-bridge `session:spawn*` actions, these handlers
 * are USER-facing (a human clicking in their own app), so they deliberately
 * skip the bot ownership gate (child.parentSessionId === caller). The tool
 * layer keeps ownership for bot-to-bot usage; the card is trusted UI.
 */
import { ipcMain } from 'electron';
import { interruptCronSession } from '../automation/agent-run';
import { getCoreStores } from '../db/core-connection';
import { getDatabase } from './db-handlers';
import { getLogger, LogComponent } from '../logging/logger';

export function registerSessionCardHandlers(): void {
  // Status + diff stats (+N/-M from chat_turn_reviews) for a child session.
  ipcMain.handle('duya:session:card', async (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string') return { ok: false, reason: 'missing_sessionId' };
    const { sessions } = getCoreStores();
    const session = sessions.get(sessionId);
    if (!session) return { ok: false, reason: 'not_found' };

    let linesAdded = 0;
    let linesRemoved = 0;
    let filesChanged = 0;
    try {
      const db = getDatabase();
      if (!db) throw new Error('legacy db unavailable');
      const reviews = db
        .prepare('SELECT additions, removals, files_json FROM chat_turn_reviews WHERE session_id = ?')
        .all(sessionId) as Array<{ additions: number | null; removals: number | null; files_json: string | null }>;
      const fileSet = new Set<string>();
      for (const r of reviews) {
        linesAdded += Number(r.additions) || 0;
        linesRemoved += Number(r.removals) || 0;
        try {
          for (const f of JSON.parse(r.files_json ?? '[]') as Array<{ path?: string }>) {
            if (f?.path) fileSet.add(f.path);
          }
        } catch {
          // files_json unparseable — ignore for stats
        }
      }
      filesChanged = fileSet.size;
    } catch (err) {
      getLogger().warn('session-card stats read failed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      }, LogComponent.AgentCommunicator);
    }

    return {
      ok: true,
      session: {
        id: sessionId,
        title: session.title ?? '',
        status: session.status ?? '',
        workingDirectory: session.workingDirectory ?? '',
        parentId: session.parentSessionId ?? null,
        filesChanged,
        linesAdded,
        linesRemoved,
        updatedAt: session.updatedAt,
        createdAt: session.createdAt,
      },
    };
  });

  // Interrupt a child session's active run (DELETE /chat).
  ipcMain.handle('duya:session:cancel', async (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string') return { ok: false, reason: 'missing_sessionId' };
    const { sessions } = getCoreStores();
    if (!sessions.get(sessionId)) return { ok: false, reason: 'not_found' };
    interruptCronSession(sessionId);
    return { ok: true, sessionId };
  });
}