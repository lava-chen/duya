/**
 * Agent Process Pool - Message routing between main and agent processes.
 */

import { handleDbRequest } from '../db-bridge.js';
import { getDatabase } from '../../ipc/db-handlers.js';
import { getPerformanceMonitor } from '../../services/performance-monitor.js';
import { getLogger, LogComponent } from '../../logging/logger.js';
import type { RunningProcess } from './process-manager.js';

export interface ProcessMessage {
  type: string;
  [key: string]: unknown;
}

export type MessageHandler = (msg: ProcessMessage) => void;

export class MessageRouter {
  private handlers = new Map<string, Set<MessageHandler>>();
  private debugIpc = process.env.DUYA_DEBUG_IPC === 'true';
  private logger = getLogger();

  register(sessionId: string, handler: MessageHandler): void {
    let set = this.handlers.get(sessionId);
    if (!set) {
      set = new Set();
      this.handlers.set(sessionId, set);
    }
    set.add(handler);
  }

  remove(sessionId: string, handler?: MessageHandler): void {
    if (handler) {
      const set = this.handlers.get(sessionId);
      if (set) {
        set.delete(handler);
        if (set.size === 0) {
          this.handlers.delete(sessionId);
        }
      }
    } else {
      this.handlers.delete(sessionId);
    }
  }

  clearSession(sessionId: string): void {
    this.handlers.delete(sessionId);
  }

  getHandlers(sessionId: string): Set<MessageHandler> | undefined {
    return this.handlers.get(sessionId);
  }

  hasHandlers(sessionId: string): boolean {
    const set = this.handlers.get(sessionId);
    return !!set && set.size > 0;
  }

  async handleMessage(
    sessionId: string,
    msg: ProcessMessage,
    proc: RunningProcess | undefined
  ): Promise<void> {
    if (msg.type === 'pong') {
      return;
    }

    if (msg.type === 'db:request') {
      await this.handleDbRequest(sessionId, msg, proc);
      return;
    }

    if (msg.type === 'chat:title_generated') {
      const titleMsg = msg as unknown as { sessionId: string; title: string };
      try {
        const db = getDatabase();
        if (db) {
          db.prepare('UPDATE chat_sessions SET title = ? WHERE id = ?').run(titleMsg.title, titleMsg.sessionId);
        }
      } catch {
        // Best-effort; logger not available in this module
      }
      this.broadcast(sessionId, msg);
      return;
    }

    // Forward to all registered handlers
    this.broadcast(sessionId, msg);

    if (msg.type === 'chat:done' || msg.type === 'chat:error') {
      getPerformanceMonitor().recordTurnMemory(sessionId);
    }
  }

  private async handleDbRequest(
    sessionId: string,
    msg: ProcessMessage,
    proc: RunningProcess | undefined
  ): Promise<void> {
    if (this.debugIpc) {
      this.logger.debug('[MessageRouter][DEBUG] db:request', {
        sessionId,
        action: (msg as { action?: string }).action,
        id: (msg as { id?: string }).id,
      }, LogComponent.AgentProcessPool);
    }

    try {
      const response = await handleDbRequest(msg as unknown as { type: 'db:request'; id: string; action: string; payload: unknown });
      const child = proc?.child;
      if (child && !child.killed) {
        try {
          child.send(response);
        } catch (sendErr) {
          this.logger.warn('Failed to send db:response to child', { sessionId, error: sendErr instanceof Error ? sendErr.message : String(sendErr) }, LogComponent.AgentProcessPool);
        }
      } else {
        this.logger.error('Cannot send db:response: child is ' + (child ? 'killed' : 'undefined'), undefined, { sessionId }, LogComponent.AgentProcessPool);
      }
    } catch (error) {
      this.logger.error('handleDbRequest failed', error instanceof Error ? error : new Error(String(error)), { sessionId }, LogComponent.AgentProcessPool);
      const child = proc?.child;
      if (child && !child.killed) {
        try {
          child.send({
            type: 'db:response',
            id: (msg as unknown as { id: string }).id,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        } catch (sendErr) {
          // C4: child.send in catch block can also throw — log and move on
          this.logger.warn('Failed to send db:response error to child', { sessionId, error: sendErr instanceof Error ? sendErr.message : String(sendErr) }, LogComponent.AgentProcessPool);
        }
      }
    }
  }

  broadcast(sessionId: string, msg: ProcessMessage): void {
    const handlers = this.handlers.get(sessionId);
    if (handlers) {
      for (const handler of handlers) {
        handler(msg);
      }
    }
  }

  broadcastDisconnect(
    sessionId: string,
    code: number | null,
    signal: NodeJS.Signals | null
  ): void {
    const handlers = this.handlers.get(sessionId);
    if (handlers) {
      for (const handler of handlers) {
        handler({ type: 'process:disconnected', code, signal } as ProcessMessage);
      }
    }
  }
}