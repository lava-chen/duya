/**
 * UserMapper - Platform user identity → DUYA session mapping
 *
 * Resolves which DUYA session an inbound platform message should route to.
 * Mapping strategy: (platform, platformChatId) → 1 session
 * Same platform, same chat window = same session (conversation continuity).
 * Different platforms = different sessions by default.
 */

import type { NormalizedMessage, PlatformType } from './types.js';
import { IpcClient } from './ipc-client.js';

export class UserMapper {
  private ipc: IpcClient;

  constructor(ipc: IpcClient) {
    this.ipc = ipc;
  }

  /**
   * Get or create a DUYA session for an inbound platform message
   */
  async getOrCreateSession(msg: NormalizedMessage): Promise<string> {
    if (!msg.platform || !msg.platformChatId) {
      throw new Error(`Missing required fields: platform=${msg.platform}, platformChatId=${msg.platformChatId}`);
    }

    // 1. Check existing mapping via db:request.
    // db-bridge returns { result: row?.session_id ?? undefined }, and ipc-client's
    // handleResponse unwraps the `result` field, so `existing` is the session_id
    // string itself (or undefined) — not an object with a session_id field.
    const existing = await this.ipc.request('db:request', {
      action: 'gateway_user:getMapping',
      payload: {
        platform: msg.platform,
        platformChatId: msg.platformChatId,
      },
    });

    const existingSessionId = typeof existing === 'string' ? existing : undefined;
    if (existingSessionId) {
      return existingSessionId;
    }

    // 2. Request Main to create session + mapping atomically (single IPC round-trip)
    const sessionId = await this.ipc.request('gateway:create_session', {
      platform: msg.platform,
      platformUserId: msg.platformUserId,
      platformChatId: msg.platformChatId,
    }) as string;

    return sessionId;
  }

  /**
   * Get the chat ID for a session (for outbound message routing)
   */
  async getChatIdForSession(sessionId: string): Promise<{ platform: PlatformType; platformChatId: string } | null> {
    // db-bridge returns { result: row ? JSON.stringify({ platform, platform_chat_id }) : undefined },
    // and ipc-client's handleResponse unwraps the `result` field, so `result` is a
    // JSON string like '{"platform":"weixin","platform_chat_id":"xxx"}' or undefined.
    const result = await this.ipc.request('db:request', {
      action: 'gateway_user:getChatForSession',
      payload: { sessionId },
    });

    if (typeof result === 'string') {
      try {
        const parsed = JSON.parse(result) as { platform?: unknown; platform_chat_id?: unknown };
        if (parsed.platform && parsed.platform_chat_id) {
          return {
            platform: parsed.platform as PlatformType,
            platformChatId: parsed.platform_chat_id as string,
          };
        }
      } catch {
        // fall through to return null
      }
    }
    return null;
  }

  /**
   * Reset session for a platform+chat (called when /new command is used).
   * Creates a new session, updates the mapping, and clears old session messages.
   */
  async resetSession(msg: NormalizedMessage): Promise<{ oldSessionId: string; newSessionId: string }> {
    const result = await this.ipc.request('gateway:reset_session', {
      platform: msg.platform,
      platformChatId: msg.platformChatId,
      platformUserId: msg.platformUserId,
      platformMsgId: msg.platformMsgId,
    }) as { sessionId?: string; oldSessionId?: string; platformMsgId?: string; error?: string };

    if (result.error) {
      throw new Error(result.error);
    }

    return {
      oldSessionId: result.oldSessionId ?? '',
      newSessionId: result.sessionId ?? '',
    };
  }
}
