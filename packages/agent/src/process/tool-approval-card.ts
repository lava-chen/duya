/**
 * tool-approval-card.ts — worker-side persistence of durable approval cards
 * (plan 498, rakazo-aligned).
 *
 * When a tool permission ask cannot be answered in-process (bot/wake runs)
 * or must survive a crash (interactive fallback), the worker persists:
 *   1. an approval row in `tool_approval_state` (one-shot ledger + status),
 *   2. a chat card message (`msg_type='tool-approval'`, source
 *      `send_message`) so the transcript — including the bot-direct view —
 *      shows the pending card with Allow once / Always allow / Deny.
 *
 * The card payload rides `metadata.sendMessage` (existing persistence
 * whitelist key) as `{ approval: ... }`; no whitelist changes needed.
 * Message ids are deterministic (`approval-card-<requestId>`), so a retried
 * write is a no-op through the append path's INSERT OR IGNORE.
 */

import { messageDb, toolApprovalDb } from '../ipc/db-client.js';
import type { ToolUseContext } from '../types.js';

export type PermissionSurface = 'bot' | 'default';

export interface ApprovalCardParams {
  requestId: string;
  sessionId: string;
  surface: PermissionSurface;
  botAgentId?: string | null;
  toolName: string;
  toolInput: Record<string, unknown>;
  mode?: string;
}

/** Human-readable fallback text rendered when the card component is absent. */
export function describeApprovalAction(toolName: string, toolInput: Record<string, unknown>): string {
  const keys = ['to', 'title', 'collection', 'subject', 'path', 'file_path', 'command', 'url'];
  const details = keys
    .map((key) => {
      const value = toolInput[key];
      if (value == null || value === '') return undefined;
      return `${key}: ${String(value).slice(0, 120)}`;
    })
    .filter((v): v is string => v !== undefined);
  const head = `Approval needed: ${toolName}`;
  return details.length > 0 ? [head, ...details.slice(0, 4)].join('\n') : head;
}

/**
 * Persist the approval row + card message. Best-effort: a failed write never
 * breaks the turn — the caller still pauses (or waits) and the ledger row is
 * simply absent, so replay falls back to the normal permission flow.
 */
export async function persistApprovalCard(params: ApprovalCardParams): Promise<void> {
  const scopeType: 'bot' | 'session' = params.surface === 'bot' ? 'bot' : 'session';
  const scopeId = (params.surface === 'bot' ? params.botAgentId : params.sessionId) || params.sessionId;
  const messageId = `approval-card-${params.requestId}`;

  await toolApprovalDb.create({
    id: params.requestId,
    messageId,
    sessionId: params.sessionId,
    scopeType,
    scopeId,
    toolName: params.toolName,
    toolInput: params.toolInput,
  });

  const content = describeApprovalAction(params.toolName, params.toolInput);
  await messageDb.append(
    params.sessionId,
    [
      {
        id: messageId,
        kind: 'tool_approval_card',
        role: 'assistant',
        content,
        status: 'complete',
        msg_type: 'tool-approval',
        source: 'send_message',
        metadata: {
          source: 'send_message',
          sendMessage: {
            approval: {
              approvalId: params.requestId,
              toolName: params.toolName,
              toolInput: params.toolInput,
              ...(params.mode ? { mode: params.mode } : {}),
            },
          },
        },
        created_at: Date.now(),
      },
    ],
    null,
  );
}

/**
 * Surface-aware permission request handler factory (plan 498).
 *
 * - 'bot': persist the approval card, then resolve 'paused'. The turn ends
 *   with a neutral tool result instead of blocking the worker; the user's
 *   later decision (anytime, even after restart) reaches the agent as a
 *   continuation run whose replayed call is authorized by the one-shot ledger.
 * - 'default': unchanged in-worker wait (chat:permission → renderer →
 *   permission:resolve, 5-minute timeout), plus a persisted card as a crash
 *   fallback — if the worker dies before the answer, the card can still be
 *   resolved later via the continuation path.
 */
export function createSurfaceAwarePermissionHandler(
  baseHandler: (request: {
    id: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    mode?: string;
    expiresAt: number;
  }) => Promise<'allow' | 'deny'>,
  params: { sessionId: string; surface: PermissionSurface; botAgentId?: string | null },
): ToolUseContext['requestPermission'] {
  return async (request) => {
    // Two-phase prompts (AskUserQuestion / ExitPlanMode) are inherently
    // interactive and must never pause — the answer has to reach the SAME
    // in-flight tool promise (plan 494 flow).
    const twoPhase = request.mode === 'ask_user_question' || request.mode === 'exit_plan_mode';
    // Persist the durable card for both surfaces (crash fallback for the
    // interactive path). Two-phase prompts are excluded.
    if (!twoPhase) {
      try {
        await persistApprovalCard({
          requestId: request.id,
          sessionId: params.sessionId,
          surface: params.surface,
          botAgentId: params.botAgentId,
          toolName: request.toolName,
          toolInput: request.toolInput,
          mode: request.mode,
        });
      } catch {
        // Card persistence is best-effort; the base handler still decides.
      }
    }
    if (params.surface === 'bot' && !twoPhase) {
      return 'paused';
    }
    return baseHandler(request);
  };
}
