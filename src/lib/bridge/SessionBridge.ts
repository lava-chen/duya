/**
 * SessionBridge.ts - Renderer-side bridge for direct MessagePort communication with Daemon
 *
 * This class provides a session-isolated communication channel to the Daemon process
 * via MessagePort. Each SessionBridge instance manages its own session lifecycle
 * and message handling.
 */

import type { ChatOptions } from './types';

export interface SessionBridgeOptions {
  sessionId: string;
  port: MessagePort;
  onError?: (error: Error) => void;
}

interface PortMessage {
  type: string;
  sessionId: string;
  payload?: unknown;
  timestamp: number;
}

interface StreamPayload {
  content: string;
  delta?: string;
  done?: boolean;
}

/**
 * SessionBridge provides a direct communication channel between Renderer and Daemon
 * via MessagePort. It handles chat streaming, interrupts, and permission resolution.
 */
export class SessionBridge {
  readonly sessionId: string;
  private port: MessagePort;
  private handlers = new Map<string, Set<(data: unknown) => void>>();
  private messageQueue: unknown[] = [];
  private isConnected = false;
  private onError?: (error: Error) => void;

  constructor(options: SessionBridgeOptions) {
    this.sessionId = options.sessionId;
    this.port = options.port;
    this.onError = options.onError;
    this.setupPort();
  }

  private setupPort(): void {
    this.port.onmessage = (event) => {
      this.handleMessage(event.data);
    };

    this.port.onmessageerror = () => {
      this.emitError(new Error('MessagePort error'));
    };

    this.port.start();
    this.isConnected = true;
    this.flushQueue();
  }

  /**
   * Send a message to the Daemon via MessagePort
   */
  send(type: string, payload?: unknown): void {
    const message = { type, sessionId: this.sessionId, payload, timestamp: Date.now() };

    if (!this.isConnected) {
      this.messageQueue.push(message);
      return;
    }

    try {
      this.port.postMessage(message);
    } catch {
      this.messageQueue.push(message);
      this.handleDisconnect();
    }
  }

  /**
   * Start a new chat in this session
   */
  startChat(prompt: string, options?: ChatOptions): void {
    this.send('chat:start', { prompt, options });
  }

  /**
   * Interrupt the current chat stream
   */
  interruptChat(): void {
    this.send('chat:interrupt');
  }

  /**
   * Resolve a permission request
   */
  resolvePermission(requestId: string, approved: boolean): void {
    this.send('permission:resolve', { requestId, approved });
  }

  /**
   * Subscribe to messages of a specific type
   * @returns Unsubscribe function
   */
  on(type: string, handler: (data: unknown) => void): () => void {
    const handlers = this.handlers.get(type) || new Set();
    handlers.add(handler);
    this.handlers.set(type, handlers);

    return () => {
      handlers.delete(handler);
    };
  }

  /**
   * Check if the bridge is currently connected
   */
  isActive(): boolean {
    return this.isConnected;
  }

  /**
   * Close the bridge and release resources
   */
  close(): void {
    this.isConnected = false;
    this.handlers.clear();
    this.messageQueue = [];
    this.port.close();
  }

  private handleMessage(data: PortMessage): void {
    const { type, payload } = data;

    // Handle high-frequency streaming events specially
    if (type === 'chat:text' || type === 'chat:thinking') {
      this.emitStream(type, payload as StreamPayload);
    }

    const handlers = this.handlers.get(type);
    if (handlers) {
      Array.from(handlers).forEach((handler) => {
        try {
          handler(payload);
        } catch (error) {
          console.error(`[SessionBridge:${this.sessionId}] Handler error for ${type}:`, error);
        }
      });
    }
  }

  private emitStream(type: string, payload: StreamPayload): void {
    const handlers = this.handlers.get(type);
    if (handlers) {
      Array.from(handlers).forEach((handler) => {
        try {
          handler(payload);
        } catch (error) {
          console.error(`[SessionBridge:${this.sessionId}] Stream handler error:`, error);
        }
      });
    }
  }

  private handleDisconnect(): void {
    this.isConnected = false;
    this.emitError(new Error('SessionBridge disconnected'));
  }

  private emitError(error: Error): void {
    const errorHandlers = this.handlers.get('error');
    if (errorHandlers) {
      Array.from(errorHandlers).forEach((handler) => {
        try {
          handler(error);
        } catch {
          // Ignore handler errors in error emitter
        }
      });
    }

    // Also call the optional onError callback
    if (this.onError) {
      try {
        this.onError(error);
      } catch {
        // Ignore errors in error callback
      }
    }
  }

  private flushQueue(): void {
    while (this.messageQueue.length > 0 && this.isConnected) {
      const message = this.messageQueue.shift();
      try {
        this.port.postMessage(message);
      } catch {
        this.messageQueue.unshift(message);
        this.handleDisconnect();
        break;
      }
    }
  }
}
