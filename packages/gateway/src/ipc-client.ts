/**
 * IpcClient - IPC communication client for Gateway ↔ Main Process
 *
 * Provides a typed request/response API for the Gateway subprocess
 * to communicate with the Electron Main Process via child_process IPC.
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
    process.send?.(message);
  }

  /**
   * Handle a response from Main Process
   * Called by the subprocess message handler for db:response and other replies
   */
  handleResponse(msg: MainToGatewayMessage & { id?: string }): void {
    const msgId = (msg as { id?: string }).id;
    const msgType = msg.type;

    // Handle db:response - match by ID
    if (msgType === 'db:response' && msgId) {
      const pending = this.pendingRequests.get(msgId);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(msgId);
        if (msg.success) {
          pending.resolve(msg.result);
        } else {
          pending.reject(new Error(msg.error ?? 'Unknown db error'));
        }
      }
      return;
    }

    // Handle gateway:create_session:response - match by type since ID may not be echoed
    if (msgType === 'gateway:create_session:response') {
      // Find the first pending gateway:create_session request
      for (const [id, pending] of this.pendingRequests) {
        if (pending.type === 'gateway:create_session') {
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(id);
          if (msg.error) {
            pending.reject(new Error(msg.error));
          } else {
            pending.resolve((msg as { sessionId?: string }).sessionId);
          }
          return;
        }
      }
      return;
    }

    // Handle gateway:reset_session:response
    if (msgType === 'gateway:reset_session:response') {
      for (const [id, pending] of this.pendingRequests) {
        if (pending.type === 'gateway:reset_session') {
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(id);
          if (msg.error) {
            pending.reject(new Error(msg.error));
          } else {
            pending.resolve(msg as { sessionId?: string; platformMsgId?: string });
          }
          return;
        }
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
