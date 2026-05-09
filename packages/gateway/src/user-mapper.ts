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
    // 1. Check existing mapping via db:request
    const existing = await this.ipc.request('db:request', {
      action: 'gateway_user:getMapping',
      payload: {
        platform: msg.platform,
        platformChatId: msg.platformChatId,
      },
    }) as { session_id?: string } | null;

    if (existing?.session_id) {
      return existing.session_id;
    }

    // 2. No existing mapping - request Main to create a new session
    const sessionId = await this.ipc.request('gateway:create_session', {
      platform: msg.platform,
      platformUserId: msg.platformUserId,
      platformChatId: msg.platformChatId,
    }) as string;

    // 3. Write mapping via db:request
    await this.ipc.request('db:request', {
      action: 'gateway_user:createMapping',
      payload: {
        platform: msg.platform,
        platformUserId: msg.platformUserId,
        platformChatId: msg.platformChatId,
        sessionId,
      },
    });

    return sessionId;
  }

  /**
   * Get the chat ID for a session (for outbound message routing)
   */
  async getChatIdForSession(sessionId: string): Promise<{ platform: PlatformType; platformChatId: string } | null> {
    const result = await this.ipc.request('db:request', {
      action: 'gateway_user:getChatForSession',
      payload: { sessionId },
    }) as { platform: PlatformType; platform_chat_id: string } | null;

    if (!result) return null;

    return {
      platform: result.platform,
      platformChatId: result.platform_chat_id,
    };
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
