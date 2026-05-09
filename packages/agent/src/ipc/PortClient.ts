/**
 * PortClient - MessagePort client for Agent subprocess
 *
 * Provides reliable communication with:
 * - Connection state monitoring
 * - Automatic reconnection with exponential backoff
 * - Message queue buffering during disconnection
 * - Type-safe message handlers
 *
 * Works with both Node.js IPC (process.send/onmessage) and Web-compatible MessagePort
 */

// =============================================================================
// TYPES & INTERFACES
// =============================================================================

export interface PortClientConfig {
  portName: string;
  maxReconnectAttempts: number;
  baseDelay: number;
  maxDelay: number;
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export interface PortMessage {
  type: string;
  [key: string]: unknown;
}

// Generic port interface for abstraction
export interface IMessagePort {
  postMessage(message: PortMessage): void;
  on?(event: 'message', handler: (data: PortMessage) => void): void;
  on?(event: 'messageerror', handler: (error: unknown) => void): void;
  close?(): void;
}

// Default configuration
const DEFAULT_CONFIG: PortClientConfig = {
  portName: 'default',
  maxReconnectAttempts: 5,
  baseDelay: 1000,
  maxDelay: 30000,
};

// =============================================================================
// PORT CLIENT CLASS
// =============================================================================

export class PortClient {
  private port: IMessagePort | null = null;
  private portName: string;
  private config: PortClientConfig;
  private connectionState: ConnectionState = 'disconnected';
  private reconnectAttempts = 0;
  private isReconnecting = false;
  private messageQueue: PortMessage[] = [];
  private handlers = new Map<string, Set<(payload: unknown) => void>>();
  private stateChangeHandlers = new Set<(state: ConnectionState) => void>();
  private errorHandlers = new Set<(error: { code: string; message?: string }) => void>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastActivity = 0;
  private messageHandler: ((data: PortMessage) => void) | null = null;
  private messageErrorHandler: ((error: unknown) => void) | null = null;

  constructor(config: Partial<PortClientConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.portName = this.config.portName;
  }

  // =============================================================================
  // PORT CONNECTION
  // =============================================================================

  /**
   * Set the MessagePort to use for communication
   */
  setPort(port: IMessagePort): void {
    this.port = port;
    this.reconnectAttempts = 0;
    this.isReconnecting = false;
    this.setupPortHandlers();
    this.setConnectionState('connected');
    this.flushQueue();
  }

  /**
   * Get the current MessagePort
   */
  getPort(): IMessagePort | null {
    return this.port;
  }

  /**
   * Get current connection state
   */
  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connectionState === 'connected';
  }

  /**
   * Get last activity timestamp
   */
  getLastActivity(): number {
    return this.lastActivity;
  }

  // =============================================================================
  // PORT HANDLERS
  // =============================================================================

  private setupPortHandlers(): void {
    if (!this.port) return;

    this.messageHandler = (data: PortMessage) => {
      this.lastActivity = Date.now();
      this.handleMessage(data);
    };

    this.messageErrorHandler = () => {
      console.error(`[PortClient:${this.portName}] Message error`);
      this.handleDisconnect();
    };

    // Support both Node.js IPC style and MessagePort style
    if ('on' in this.port && typeof this.port.on === 'function') {
      this.port.on('message', this.messageHandler);
      this.port.on('messageerror', this.messageErrorHandler);
    }
  }

  private handleMessage(data: PortMessage): void {
    const { type, ...payload } = data;

    const typeHandlers = this.handlers.get(type);
    if (typeHandlers) {
      for (const handler of typeHandlers) {
        try {
          handler(payload);
        } catch (error) {
          console.error(`[PortClient:${this.portName}] Handler error for ${type}:`, error);
        }
      }
    }

    // Also emit to wildcard handlers
    const wildcardHandlers = this.handlers.get('*');
    if (wildcardHandlers) {
      for (const handler of wildcardHandlers) {
        try {
          handler(data);
        } catch (error) {
          console.error(`[PortClient:${this.portName}] Wildcard handler error:`, error);
        }
      }
    }
  }

  private handleDisconnect(): void {
    if (this.isReconnecting) return;
    this.isReconnecting = true;
    this.setConnectionState('reconnecting');

    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      console.error(`[PortClient:${this.portName}] Max reconnect attempts reached`);
      this.setConnectionState('disconnected');
      this.emitError({ code: 'MAX_RECONNECT_ATTEMPTS' });
      return;
    }

    const delay = Math.min(
      this.config.baseDelay * Math.pow(2, this.reconnectAttempts),
      this.config.maxDelay
    );

    console.log(`[PortClient:${this.portName}] Reconnecting in ${delay}ms...`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectAttempts++;
      this.isReconnecting = false;
      this.emitError({ code: 'RECONNECTING' });
    }, delay);
  }

  // =============================================================================
  // MESSAGE SENDING
  // =============================================================================

  /**
   * Send a message through the port
   */
  send(type: string, payload: Record<string, unknown> = {}): void {
    const message: PortMessage = { type, ...payload };

    if (!this.port || this.connectionState !== 'connected') {
      // Queue message for later
      this.messageQueue.push(message);
      return;
    }

    try {
      this.port.postMessage(message);
      this.lastActivity = Date.now();
    } catch (error) {
      console.error(`[PortClient:${this.portName}] Send failed:`, error);
      this.messageQueue.push(message);
      this.handleDisconnect();
    }
  }

  /**
   * Send a message and wait for a response
   */
  sendWithResponse<T>(type: string, payload: Record<string, unknown> = {}, timeoutMs = 30000): Promise<T> {
    return new Promise((resolve, reject) => {
      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

      // Set up response handler
      const responseHandler = (response: Record<string, unknown>) => {
        if (response.requestId === requestId) {
          this.off(type + ':response', responseHandler as (payload: unknown) => void);
          clearTimeout(timeout);
          if (response.error) {
            reject(new Error(String(response.error)));
          } else {
            resolve(response as T);
          }
        }
      };

      this.on(type + ':response', responseHandler as (payload: unknown) => void);

      // Set up timeout
      const timeout = setTimeout(() => {
        this.off(type + ':response', responseHandler as (payload: unknown) => void);
        reject(new Error(`Timeout waiting for ${type} response`));
      }, timeoutMs);

      // Send the message with request ID
      this.send(type, { ...payload, requestId });
    });
  }

  private flushQueue(): void {
    if (this.messageQueue.length === 0) return;
    if (!this.port || this.connectionState !== 'connected') return;

    console.log(`[PortClient:${this.portName}] Flushing ${this.messageQueue.length} queued messages`);

    const queue = [...this.messageQueue];
    this.messageQueue = [];

    for (const message of queue) {
      try {
        this.port.postMessage(message);
      } catch (error) {
        console.error(`[PortClient:${this.portName}] Failed to flush message:`, error);
        this.messageQueue.push(message);
        this.handleDisconnect();
        break;
      }
    }
  }

  // =============================================================================
  // EVENT HANDLERS
  // =============================================================================

  /**
   * Register a handler for a specific message type
   */
  on<T = unknown>(type: string, handler: (payload: T) => void): () => void {
    const handlers = this.handlers.get(type) as Set<(payload: T) => void> || new Set();
    handlers.add(handler);
    this.handlers.set(type, handlers as Set<(payload: unknown) => void>);

    return () => {
      const h = this.handlers.get(type) as Set<(payload: T) => void> | undefined;
      if (h) {
        h.delete(handler);
        if (h.size === 0) {
          this.handlers.delete(type);
        }
      }
    };
  }

  /**
   * Register a one-time handler for a specific message type
   */
  once<T = unknown>(type: string, handler: (payload: T) => void): () => void {
    const wrappedHandler = (payload: unknown) => {
      this.off(type, wrappedHandler);
      handler(payload as T);
    };
    return this.on(type, wrappedHandler);
  }

  /**
   * Remove a handler
   */
  off<T = unknown>(type: string, handler: (payload: T) => void): void {
    const handlers = this.handlers.get(type) as Set<(payload: T) => void> | undefined;
    if (handlers) {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.handlers.delete(type);
      }
    }
  }

  /**
   * Register a handler for connection state changes
   */
  onStateChange(handler: (state: ConnectionState) => void): () => void {
    this.stateChangeHandlers.add(handler);
    return () => {
      this.stateChangeHandlers.delete(handler);
    };
  }

  /**
   * Register a handler for errors
   */
  onError(handler: (error: { code: string; message?: string }) => void): () => void {
    this.errorHandlers.add(handler);
    return () => {
      this.errorHandlers.delete(handler);
    };
  }

  private setConnectionState(state: ConnectionState): void {
    this.connectionState = state;
    for (const handler of this.stateChangeHandlers) {
      try {
        handler(state);
      } catch (error) {
        console.error(`[PortClient:${this.portName}] State change handler error:`, error);
      }
    }
  }

  private emitError(error: { code: string; message?: string }): void {
    for (const handler of this.errorHandlers) {
      try {
        handler(error);
      } catch (err) {
        console.error(`[PortClient:${this.portName}] Error handler error:`, err);
      }
    }
  }

  // =============================================================================
  // CLEANUP
  // =============================================================================

  /**
   * Close the connection and clean up
   */
  close(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.port) {
      try {
        if ('close' in this.port && typeof this.port.close === 'function') {
          this.port.close();
        }
      } catch {}
      this.port = null;
    }

    this.messageQueue = [];
    this.handlers.clear();
    this.stateChangeHandlers.clear();
    this.errorHandlers.clear();
    this.setConnectionState('disconnected');
  }

  /**
   * Get queued message count
   */
  getQueueSize(): number {
    return this.messageQueue.length;
  }

  /**
   * Get reconnect attempts
   */
  getReconnectAttempts(): number {
    return this.reconnectAttempts;
  }
}

// =============================================================================
// MESSAGE TYPE HELPERS
// =============================================================================

export interface ToolExecuteMessage {
  type: 'tool:execute';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultMessage {
  type: 'tool:result';
  id: string;
  result?: unknown;
  error?: string;
}

export interface ToolOutputMessage {
  type: 'tool:output';
  toolUseId: string;
  stream: 'stdout' | 'stderr';
  data: string;
}

export interface ToolProgressMessage {
  type: 'tool:progress';
  toolUseId: string;
  percent: number;
  stage: string;
}

export interface ConfigUpdateMessage {
  type: 'config:update';
  config: Record<string, unknown>;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

// =============================================================================
// TOOL EXEC CHANNEL CLIENT
// =============================================================================

export class ToolExecPortClient extends PortClient {
  constructor() {
    super({ portName: 'toolExec', maxReconnectAttempts: 5 });
  }

  executeTool(id: string, name: string, input: Record<string, unknown>): void {
    this.send('tool:execute', { id, name, input });
  }

  abortTool(toolUseId: string): void {
    this.send('tool:abort', { toolUseId });
  }

  onToolResult(handler: (payload: { id: string; result?: unknown; error?: string }) => void): () => void {
    return this.on<{ id: string; result?: unknown; error?: string }>('tool:result', handler);
  }

  onToolProgress(handler: (payload: { toolUseId: string; percent: number; stage: string }) => void): () => void {
    return this.on<{ toolUseId: string; percent: number; stage: string }>('tool:progress', handler);
  }
}

// =============================================================================
// TOOL STREAM CHANNEL CLIENT
// =============================================================================

export class ToolStreamPortClient extends PortClient {
  constructor() {
    super({ portName: 'toolStream', maxReconnectAttempts: 5 });
  }

  onToolOutput(handler: (payload: { toolUseId: string; stream: 'stdout' | 'stderr'; data: string }) => void): () => void {
    return this.on<{ toolUseId: string; stream: 'stdout' | 'stderr'; data: string }>('tool:output', handler);
  }
}

// =============================================================================
// CONFIG CHANNEL CLIENT
// =============================================================================

export class ConfigPortClient extends PortClient {
  constructor() {
    super({ portName: 'config', maxReconnectAttempts: 3 });
  }

  getConfig(key: string): void {
    this.send('config:get', { key });
  }

  setConfig(key: string, value: unknown): void {
    this.send('config:set', { key, value });
  }

  subscribe(): void {
    this.send('config:subscribe');
  }

  onConfigUpdate(handler: (payload: { config: Record<string, unknown> }) => void): () => void {
    return this.on<{ config: Record<string, unknown> }>('config:update', handler);
  }

  onConfigResponse(handler: (payload: { key: string; value: unknown }) => void): () => void {
    return this.on<{ key: string; value: unknown }>('config:response', handler);
  }
}
