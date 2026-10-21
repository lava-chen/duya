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
import { getDesktopHostLocalSessionApi, getDesktopHostSessionApi } from '../cli/desktop-host-api';
import { getLogger, LogComponent } from '../logging/logger';

export function registerSessionCardHandlers(): void {
  // Status + diff stats (+N/-M from chat_turn_reviews) for a child session.
  ipcMain.handle('duya:session:card', async (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string') return { ok: false, reason: 'missing_sessionId' };
    const session = await getDesktopHostLocalSessionApi().readLocalSession(sessionId, {
      includeAllSessions: true,
    });
    if (!session) return { ok: false, reason: 'not_found' };

    let stats = { filesChanged: 0, linesAdded: 0, linesRemoved: 0 };
    try {
      stats = await getDesktopHostSessionApi().getSessionChangeStats(sessionId);
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
        ...stats,
        updatedAt: session.updatedAt,
        createdAt: session.createdAt,
      },
    };
  });

  // Interrupt a child session's active run (DELETE /chat).
  ipcMain.handle('duya:session:cancel', async (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string') return { ok: false, reason: 'missing_sessionId' };
    const session = await getDesktopHostLocalSessionApi().readLocalSession(sessionId, {
      includeAllSessions: true,
    });
    if (!session) return { ok: false, reason: 'not_found' };
    interruptCronSession(sessionId);
    return { ok: true, sessionId };
  });
}
