/**
 * Mirror write-back: append outbound gateway replies to the session transcript.
 *
 * When the gateway sends a reply that the agent worker never persisted (e.g. a
 * ledger-redelivered message after a crash, or a gateway-originated action),
 * the session transcript would silently diverge from what the platform user
 * actually received. This module appends a delivery-mirror record to the
 * session's transcript via the Main-process `gateway_user:appendMirror` action,
 * keeping the agent's context consistent with the outbound reality.
 *
 * Best-effort by design: a mirror failure is never fatal to message delivery.
 */

import type { IpcClient } from './ipc-client.js';
import type { PlatformType } from './types.js';

export class DeliveryMirror {
  private ipc: IpcClient;

  constructor(ipc: IpcClient) {
    this.ipc = ipc;
  }

  /**
   * Resolve the session id for a (platform, chatId) pair via the user mapping.
   * Returns null when no mapping exists.
   */
  async resolveSessionId(platform: PlatformType, chatId: string): Promise<string | null> {
    const existing = await this.ipc.request('db:request', {
      action: 'gateway_user:getMapping',
      payload: { platform, platformChatId: chatId },
    });
    return typeof existing === 'string' ? existing : null;
  }

  /**
   * Append a mirror of an outbound text reply to the session transcript.
   *
   * @param platform  Platform the reply was sent to.
   * @param chatId    Chat the reply was sent to.
   * @param text      The outbound text that was delivered to the platform.
   * @param role      Role of the mirrored turn. Defaults to 'assistant',
   *                  correct for most gateway-originated replies; pass 'user'
   *                  for out-of-band deliveries that are not the agent speaking.
   */
  async mirrorText(
    platform: PlatformType,
    chatId: string,
    text: string,
    role: 'user' | 'assistant' = 'assistant',
  ): Promise<void> {
    if (!text) return;
    try {
      const sessionId = await this.resolveSessionId(platform, chatId);
      if (!sessionId) return;
      await this.ipc.request('db:request', {
        action: 'gateway_user:appendMirror',
        payload: { session_id: sessionId, content: text, role },
      });
    } catch {
      // Best-effort: a mirror failure must never block or break delivery.
    }
  }
}