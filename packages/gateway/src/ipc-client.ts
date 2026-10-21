/**
 * IpcClient - IPC communication client for Gateway ↔ Main Process
 *
 * Provides a typed request/response API for the Gateway subprocess
 * to communicate with the Electron Main Process via child_process IPC.
 *
 * Plan 520: permission / pairing / session-mapping / command-forwarding
 * methods are gone — the gateway only does generic request/response and
 * one-way sends, plus the `gateway:inbound` allow-list verdict match.
 */

import type { MainToGatewayMessage, GatewayToMainMessage } from './types.js';

interface PendingRequest {
  type: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT_MS = 30000;

export class IpcClient {
  private pendingRequests = new Map<string, PendingRequest>();
  private requestId = 0;

  /**
   * Send a request to Main Process and wait for response
   * Uses the same db:request/db:response pattern as AgentProcess
   */
  async request(type: string, data: Record<string, unknown> = {}): Promise<unknown> {
    const id = `gw-${++this.requestId}-${Date.now()}`;
    console.log('[IpcClient] request:', { type, id, dataKeys: Object.keys(data) });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Gateway IPC request ${type} timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(id, { type, resolve, reject, timeout });

      // Send via child_process IPC
      process.send?.({ type, id, ...data } as GatewayToMainMessage);
    });
  }

  /**
   * Send a one-way message to Main Process (no response expected)
   */
  send(message: GatewayToMainMessage): void {
    console.log('[IpcClient] send:', { type: message.type, hasId: 'id' in message });
    process.send?.(message);
  }

  /**
   * Handle a response from Main Process
   * Called by the subprocess message handler for replies to pending requests
   */
  handleResponse(msg: MainToGatewayMessage & { id?: string }): void {
    const msgId = (msg as { id?: string }).id;
    const msgType = msg.type;
    console.log('[IpcClient] handleResponse:', { msgId, msgType, hasSuccess: 'success' in msg });

    // Handle db:response - match by ID
    if (msgType === 'db:response' && msgId) {
      const pending = this.pendingRequests.get(msgId);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(msgId);
        if ((msg as { success?: boolean }).success) {
          pending.resolve((msg as { result?: unknown }).result);
        } else {
          pending.reject(new Error((msg as { error?: string }).error ?? 'Unknown db error'));
        }
      } else {
        console.warn('[IpcClient] No pending request found for id:', msgId);
      }
      return;
    }

    // Handle the gateway:inbound allow-list verdict (plan 520): Main resolves
    // the session and checks the channel allow-list, then replies with a
    // boolean. Matched by id like db:response.
    if (msgType === 'gateway:inbound:response' && msgId) {
      const pending = this.pendingRequests.get(msgId);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(msgId);
        pending.resolve((msg as { authorized?: boolean }).authorized === true);
      }
      return;
    }
  }

  /**
   * Reject all pending requests (called on shutdown)
   */
  rejectAll(reason: string): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(reason));
    }
    this.pendingRequests.clear();
  }
}
