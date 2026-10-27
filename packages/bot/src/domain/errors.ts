/**
 * errors.ts — the Bot service error (framework plan S2, moved from the Host's
 * `bot/service.ts`).
 *
 * The error CODE vocabulary lives on the wire in
 * `@duya/agent-protocol/bot-api` (`BotErrorCode`); this package re-exports
 * that type instead of copying it.
 */

import type { BotErrorCode } from '@duya/agent-protocol/bot-api';

export class BotServiceError extends Error {
  constructor(
    readonly code: BotErrorCode,
    message: string,
    readonly details?: Record<string, unknown> | undefined,
  ) {
    // The code rides the message too: bridge transports that serialize only
    // `message` must not flatten a conflict into a generic failure string.
    super(`[${code}] ${message}`);
    this.name = 'BotServiceError';
  }
}
