/**
 * message-port-manager.ts - MessagePort lifecycle management for IPC routing
 *
 * Simplifed version - removed reconnect logic because MessagePort cannot be
 * reconnected (port lifecycle is tied to window, window close = port death).
 *
 * Features:
 * - Port registration and lifecycle management
 * - Per-channel message routing (Main ↔ Renderer)
 * - Event subscription for messages
 * - Metrics tracking (optional, for debugging)
 */

import { ElectronMessagePortMain } from './port-types';
import { getLogger, LogComponent } from './logger';

// =============================================================================
// TYPES & INTERFACES
// =============================================================================

export type PortState = 'connected' | 'error' | 'closed';

export interface ManagedPort {
  name: string;
  port: ElectronMessagePortMain;
  state: PortState;
  lastActivity: number;
  messagesSent: number;
  messagesReceived: number;
  errorCount: number;
}

export type PortErrorCode = 'PORT_CLOSED' | 'SEND_FAILED';

export interface PortError {
  name: string;
  code: PortErrorCode;
  message?: string;
}

export interface ChannelDefinition {
  name: string;
}

// =============================================================================
// MESSAGE PORT MANAGER CLASS
// =============================================================================

export class MessagePortManager {
  private ports = new Map<string, ManagedPort>();
  private eventHandlers = new Map<string, Set<(data: unknown) => void>>();
  private logger = getLogger();

  // =============================================================================
  // PORT REGISTRATION
  // =============================================================================

  registerPort(name: string, port: ElectronMessagePortMain): void {
    const existing = this.ports.get(name);
    if (existing) {
      this.cleanupPort(existing);
    }

    const managedPort: ManagedPort = {
      name,
      port,
      state: 'connected',
      lastActivity: Date.now(),
      messagesSent: 0,
      messagesReceived: 0,
      errorCount: 0,
    };

    this.ports.set(name, managedPort);
    this.setupPortHandlers(name, port);

    this.logger.info(`Port registered: ${name}`, undefined, LogComponent.PortManager);
  }

  unregisterPort(name: string): void {
    const managedPort = this.ports.get(name);
    if (!managedPort) return;

    this.cleanupPort(managedPort);
    this.ports.delete(name);
    this.eventHandlers.delete(`${name}:message`);
    this.eventHandlers.delete(`${name}:error`);

    this.logger.info(`Port unregistered: ${name}`, undefined, LogComponent.PortManager);
  }

  private cleanupPort(managedPort: ManagedPort): void {
    try {
      managedPort.port.close();
    } catch {}
  }

  // =============================================================================
  // PORT HANDLERS
  // =============================================================================

  private setupPortHandlers(name: string, port: ElectronMessagePortMain): void {
    port.on('message', (event) => {
      this.handleMessage(name, event.data);
    });

    port.on('close', () => {
      this.logger.warn(`Port closed: ${name}`, undefined, LogComponent.PortManager);
      this.handlePortClose(name);
    });

    try {
      port.start();
    } catch {}
  }

  private handleMessage(name: string, data: unknown): void {
    const managedPort = this.ports.get(name);
    if (managedPort) {
      managedPort.lastActivity = Date.now();
      managedPort.messagesReceived++;
    }

    this.emit(`${name}:message`, data);
  }

  private handlePortClose(name: string): void {
    const managedPort = this.ports.get(name);
    if (!managedPort) return;

    managedPort.state = 'closed';
    this.emitError(name, 'PORT_CLOSED');
  }

  // =============================================================================
  // MESSAGE SENDING
  // =============================================================================

  sendMessage(name: string, message: unknown): boolean {
    const managedPort = this.ports.get(name);

    if (!managedPort || managedPort.state !== 'connected') {
      this.logger.warn(`sendMessage: port '${name}' not connected`, { state: managedPort?.state }, LogComponent.PortManager);
      return false;
    }

    try {
      managedPort.port.postMessage(message);
      managedPort.lastActivity = Date.now();
      managedPort.messagesSent++;
      return true;
    } catch (error) {
      this.logger.error('Send failed', error instanceof Error ? error : new Error(String(error)), { name }, LogComponent.PortManager);
      managedPort.errorCount++;
      this.emitError(name, 'SEND_FAILED');
      return false;
    }
  }

  // =============================================================================
  // STATE & METRICS
  // =============================================================================

  getPortState(name: string): PortState | undefined {
    return this.ports.get(name)?.state;
  }

  isConnected(name: string): boolean {
    return this.getPortState(name) === 'connected';
  }

  getLastActivity(name: string): number | undefined {
    return this.ports.get(name)?.lastActivity;
  }

  getAllPortStates(): Record<string, { state: PortState; lastActivity: number; messagesSent: number; messagesReceived: number; errorCount: number }> {
    const states: Record<string, { state: PortState; lastActivity: number; messagesSent: number; messagesReceived: number; errorCount: number }> = {};
    for (const [name, port] of this.ports) {
      states[name] = {
        state: port.state,
        lastActivity: port.lastActivity,
        messagesSent: port.messagesSent,
        messagesReceived: port.messagesReceived,
        errorCount: port.errorCount,
      };
    }
    return states;
  }

  getPortStats(name: string): { messagesSent: number; messagesReceived: number; errorCount: number; lastActivity: number } | undefined {
    const port = this.ports.get(name);
    if (!port) return undefined;
    return {
      messagesSent: port.messagesSent,
      messagesReceived: port.messagesReceived,
      errorCount: port.errorCount,
      lastActivity: port.lastActivity,
    };
  }

  getAllStats(): Record<string, unknown> {
    const stats: Record<string, unknown> = {};
    for (const [name, port] of this.ports) {
      stats[name] = {
        state: port.state,
        messagesSent: port.messagesSent,
        messagesReceived: port.messagesReceived,
        errorCount: port.errorCount,
        lastActivity: new Date(port.lastActivity).toISOString(),
      };
    }
    return stats;
  }

  // =============================================================================
  // ERROR HANDLING
  // =============================================================================

  onError(name: string, handler: (error: PortError) => void): () => void {
    const key = `${name}:error`;
    const handlers = this.eventHandlers.get(key) as Set<(error: PortError) => void> || new Set();
    handlers.add(handler);
    this.eventHandlers.set(key, handlers as Set<(data: unknown) => void>);

    return () => {
      const h = this.eventHandlers.get(key) as Set<(error: PortError) => void> | undefined;
      if (h) {
        h.delete(handler);
      }
    };
  }

  private emitError(name: string, code: PortErrorCode): void {
    const error: PortError = { name, code };
    const key = `${name}:error`;
    const handlers = this.eventHandlers.get(key) as Set<(error: PortError) => void> | undefined;
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(error);
        } catch (err) {
          this.logger.error('Error handler failed', err instanceof Error ? err : new Error(String(err)), { name }, LogComponent.PortManager);
        }
      }
    }
  }

  // =============================================================================
  // MESSAGE EVENTS
  // =============================================================================

  onMessage(name: string, handler: (data: unknown) => void): () => void {
    const key = `${name}:message`;
    const handlers = this.eventHandlers.get(key) || new Set();
    handlers.add(handler);
    this.eventHandlers.set(key, handlers);

    return () => {
      const h = this.eventHandlers.get(key);
      if (h) {
        h.delete(handler);
      }
    };
  }

  private emit(key: string, data: unknown): void {
    const handlers = this.eventHandlers.get(key);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(data);
        } catch (err) {
          this.logger.error('Message handler failed', err instanceof Error ? err : new Error(String(err)), { key }, LogComponent.PortManager);
        }
      }
    }
  }

  // =============================================================================
  // CLEANUP
  // =============================================================================

  removeAllPorts(): void {
    for (const [, port] of this.ports) {
      this.cleanupPort(port);
    }
    this.ports.clear();
    this.eventHandlers.clear();
  }

  shutdown(): void {
    this.removeAllPorts();
  }
}

// =============================================================================
// CHANNEL MANAGER - Manages multiple named channels
// =============================================================================

export class ChannelManager {
  private channels = new Map<string, MessagePortManager>();

  constructor(channelConfigs: ChannelDefinition[] = []) {
    for (const config of channelConfigs) {
      const manager = new MessagePortManager();
      this.channels.set(config.name, manager);
    }
  }

  registerChannel(name: string, port: ElectronMessagePortMain): void {
    const manager = this.channels.get(name);
    if (manager) {
      manager.registerPort(name, port);
    } else {
      const newManager = new MessagePortManager();
      newManager.registerPort(name, port);
      this.channels.set(name, newManager);
    }
  }

  getChannel(name: string): MessagePortManager | undefined {
    return this.channels.get(name);
  }

  getAllChannels(): Map<string, MessagePortManager> {
    return this.channels;
  }

  onChannelError(name: string, handler: (error: PortError) => void): () => void {
    const manager = this.channels.get(name);
    if (manager) {
      return manager.onError(name, handler);
    }
    return () => {};
  }

  onChannelMessage(name: string, handler: (data: unknown) => void): () => void {
    const manager = this.channels.get(name);
    if (manager) {
      return manager.onMessage(name, handler);
    }
    return () => {};
  }

  sendToChannel(name: string, message: unknown): boolean {
    const manager = this.channels.get(name);
    if (manager) {
      return manager.sendMessage(name, message);
    }
    return false;
  }

  getAllStats(): Record<string, unknown> {
    const stats: Record<string, unknown> = {};
    for (const [name, manager] of this.channels) {
      stats[name] = manager.getAllStats();
    }
    return stats;
  }

  shutdown(): void {
    for (const manager of this.channels.values()) {
      manager.shutdown();
    }
    this.channels.clear();
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let channelManager: ChannelManager | null = null;

export function getChannelManager(): ChannelManager {
  if (!channelManager) {
    channelManager = new ChannelManager([
      { name: 'config' },
      { name: 'toolExec' },
      { name: 'toolStream' },
      { name: 'agentControl' },
      { name: 'conductor' },
    ]);
  }
  return channelManager;
}

export function initChannelManager(configs?: ChannelDefinition[]): ChannelManager {
  if (channelManager) {
    getLogger().warn('Already initialized', undefined, LogComponent.ChannelManager);
    return channelManager;
  }
  channelManager = new ChannelManager(configs);
  return channelManager;
}