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
   * Check if a user is approved for a platform
   */
  async checkPairing(platform: string, platformUserId: string): Promise<{ approved: boolean }> {
    return this.request('gateway:pairing:check', { platform, platformUserId }) as Promise<{ approved: boolean }>;
  }

  /**
   * Generate a pairing code for a user
   */
  async generatePairingCode(
    platform: string,
    platformUserId: string,
    platformChatId: string,
    userName: string
  ): Promise<{ code: string; error?: string }> {
    return this.request('gateway:pairing:generate', {
      platform,
      platformUserId,
      platformChatId,
      userName,
    }) as Promise<{ code: string; error?: string }>;
  }

  /**
   * Approve a pairing code
   */
  async approvePairingCode(platform: string, code: string): Promise<{ approved: boolean; error?: string }> {
    return this.request('gateway:pairing:approve', { platform, code }) as Promise<{ approved: boolean; error?: string }>;
  }

  /**
   * Revoke a user's pairing
   */
  async revokePairing(platform: string, platformUserId: string): Promise<{ revoked: boolean }> {
    return this.request('gateway:pairing:revoke', { platform, platformUserId }) as Promise<{ revoked: boolean }>;
  }

  /**
   * List all pairings
   */
  async listPairings(): Promise<{ pending: unknown[]; approved: unknown[] }> {
    return this.request('gateway:pairing:list', {}) as Promise<{ pending: unknown[]; approved: unknown[] }>;
  }

  /**
   * Handle a response from Main Process
   * Called by the subprocess message handler for db:response and other replies
   */
  handleResponse(msg: MainToGatewayMessage & { id?: string }): void {
    const msgId = (msg as { id?: string }).id;
    const msgType = msg.type;
    console.log('[IpcClient] handleResponse:', { msgId, msgType, hasSuccess: 'success' in msg });

    // Handle db:response - match by ID
    if (msgType === 'db:response' && msgId) {
      console.log('[IpcClient] db:response matched, searching pending request...');
      const pending = this.pendingRequests.get(msgId);
      if (pending) {
        console.log('[IpcClient] Found pending request:', pending.type);
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(msgId);
        if ((msg as { success?: boolean }).success) {
          console.log('[IpcClient] Resolving with result:', (msg as { result?: unknown }).result);
          pending.resolve((msg as { result?: unknown }).result);
        } else {
          console.log('[IpcClient] Rejecting with error:', (msg as { error?: string }).error);
          pending.reject(new Error((msg as { error?: string }).error ?? 'Unknown db error'));
        }
      } else {
        console.warn('[IpcClient] No pending request found for id:', msgId);
      }
      return;
    }

    // Handle gateway:create_session:response - match by ID first (Main echoes id),
    // fall back to type-based match for backward compat with older Main processes.
    if (msgType === 'gateway:create_session:response') {
      const msgId = (msg as { id?: string }).id;
      const sessionId = (msg as { sessionId?: string }).sessionId;
      console.log('[IpcClient] gateway:create_session:response sessionId:', sessionId, 'id:', msgId);

      // Prefer matching by id to avoid race conditions under concurrent session creation.
      if (msgId) {
        const pending = this.pendingRequests.get(msgId);
        if (pending && pending.type === 'gateway:create_session') {
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(msgId);
          if ((msg as { error?: string }).error) {
            console.log('[IpcClient] Rejecting gateway:create_session due to error:', (msg as { error?: string }).error);
            pending.reject(new Error((msg as { error?: string }).error));
          } else {
            console.log('[IpcClient] Resolving gateway:create_session with sessionId:', sessionId);
            pending.resolve(sessionId);
          }
          return;
        }
      }

      // Fallback: match by type (legacy Main processes that do not echo id).
      for (const [id, pending] of this.pendingRequests) {
        if (pending.type === 'gateway:create_session') {
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(id);
          if ((msg as { error?: string }).error) {
            console.log('[IpcClient] Rejecting gateway:create_session due to error:', (msg as { error?: string }).error);
            pending.reject(new Error((msg as { error?: string }).error));
          } else {
            console.log('[IpcClient] Resolving gateway:create_session with sessionId:', sessionId);
            pending.resolve(sessionId);
          }
          return;
        }
      }
      console.warn('[IpcClient] No pending gateway:create_session request found');
      return;
    }

    // Handle gateway:reset_session:response - match by ID first, fall back to type.
    if (msgType === 'gateway:reset_session:response') {
      const msgId = (msg as { id?: string }).id;

      if (msgId) {
        const pending = this.pendingRequests.get(msgId);
        if (pending && pending.type === 'gateway:reset_session') {
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(msgId);
          if ((msg as { error?: string }).error) {
            pending.reject(new Error((msg as { error?: string }).error));
          } else {
            pending.resolve(msg as { sessionId?: string; platformMsgId?: string });
          }
          return;
        }
      }

      // Fallback: match by type.
      for (const [id, pending] of this.pendingRequests) {
        if (pending.type === 'gateway:reset_session') {
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(id);
          if ((msg as { error?: string }).error) {
            pending.reject(new Error((msg as { error?: string }).error));
          } else {
            pending.resolve(msg as { sessionId?: string; platformMsgId?: string });
          }
          return;
        }
      }
      return;
    }

    // Handle pairing responses - match by ID first, fall back to type.
    if (msgType === 'gateway:pairing:check:response') {
      const msgId = (msg as { id?: string }).id;

      if (msgId) {
        const pending = this.pendingRequests.get(msgId);
        if (pending && pending.type === 'gateway:pairing:check') {
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(msgId);
          pending.resolve(msg);
          return;
        }
      }

      for (const [id, pending] of this.pendingRequests) {
        if (pending.type === 'gateway:pairing:check') {
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(id);
          pending.resolve(msg);
          return;
        }
      }
      return;
    }

    if (msgType === 'gateway:pairing:generate:response') {
      const msgId = (msg as { id?: string }).id;

      if (msgId) {
        const pending = this.pendingRequests.get(msgId);
        if (pending && pending.type === 'gateway:pairing:generate') {
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(msgId);
          pending.resolve(msg);
          return;
        }
      }

      for (const [id, pending] of this.pendingRequests) {
        if (pending.type === 'gateway:pairing:generate') {
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(id);
          pending.resolve(msg);
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
