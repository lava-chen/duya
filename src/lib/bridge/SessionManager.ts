/**
 * SessionManager.ts - Session lifecycle management for Renderer
 *
 * Manages the creation, destruction, and reconnection of SessionBridge instances.
 * Coordinates between the ConversationStore and the Daemon via MessagePort.
 */

import { SessionBridge } from './SessionBridge';
import type { SessionState, ToolUsePayload, ToolResultPayload, PermissionRequestPayload } from './types';

// View types matching the store
type ViewType = 'home' | 'chat' | 'settings' | 'skills' | 'bridge';
type SettingsTab = 'general' | 'appearance' | 'providers' | 'skills';

// Message type
interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  name?: string;
  tool_call_id?: string;
  timestamp: number;
  tokenUsage?: unknown;
}

// Thread type
interface Thread {
  id: string;
  title: string;
  workingDirectory: string | null;
  projectName: string | null;
  createdAt: number;
  updatedAt: number;
}

// Get the full store type (state + actions) from the Zustand store
type ConversationStore = {
  // State
  currentView: ViewType;
  settingsTab: SettingsTab;
  threads: Thread[];
  activeThreadId: string | null;
  messages: Record<string, Message[]>;
  isHydrated: boolean;
  projects: { workingDirectory: string; projectName: string; threadCount: number; lastActivity: number; isExpanded: boolean }[];
  collapsedProjects: Set<string>;
  lastSyncAt: number;
  // Actions
  setCurrentView: (view: ViewType) => void;
  setSettingsTab: (tab: SettingsTab) => void;
  createThread: (options?: { workingDirectory?: string; projectName?: string }) => Thread | null;
  deleteThread: (id: string) => void;
  setActiveThread: (id: string) => void;
  addMessage: (threadId: string, message: Message) => void;
  clearMessages: (threadId: string) => void;
  updateThreadTitle: (id: string, title: string) => void;
  setThreadWorkingDirectory: (id: string, workingDirectory: string, projectName: string) => void;
  toggleProjectExpanded: (workingDirectory: string) => void;
  loadFromDatabase: () => Promise<void>;
  loadThreadMessages: (threadId: string) => Promise<void>;
  syncThreadToDatabase: (thread: Thread) => Promise<void>;
  syncMessageToDatabase: (threadId: string, message: Message) => Promise<void>;
  forceSync: () => Promise<void>;
};

/**
 * SessionManager handles session lifecycle including creation, destruction,
 * and crash recovery. It creates and manages SessionBridge instances.
 */
export class SessionManager {
  private sessions = new Map<string, SessionState>();
  private bridges = new Map<string, SessionBridge>();
  private store: ConversationStore;

  constructor(store: ConversationStore) {
    this.store = store;
  }

  /**
   * Create a new session and return its ID
   */
  async createSession(agentType: string): Promise<string> {
    const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // 1. Get MessagePort via electronAPI
    const port = await this.waitForMessagePort();
    if (!port) {
      throw new Error('MessagePort not available');
    }

    // 2. Create SessionBridge
    const bridge = new SessionBridge({
      sessionId,
      port,
      onError: (error) => {
        console.error(`[SessionManager:${sessionId}] Bridge error:`, error);
      },
    });
    this.bridges.set(sessionId, bridge);

    // 3. Initialize store - create thread for this session
    const thread = await this.store.createThread();
    if (!thread) {
      bridge.close();
      this.bridges.delete(sessionId);
      throw new Error('Failed to create thread in store');
    }

    // 4. Setup Bridge event handlers to update store
    this.setupBridgeHandlers(sessionId, bridge);

    // 5. Save session state
    this.sessions.set(sessionId, {
      id: sessionId,
      agentType,
      status: 'active',
      createdAt: Date.now(),
      lastActivity: Date.now(),
    });

    return sessionId;
  }

  /**
   * Destroy a session and clean up resources
   */
  async destroySession(sessionId: string): Promise<void> {
    const bridge = this.bridges.get(sessionId);
    if (bridge) {
      bridge.close();
      this.bridges.delete(sessionId);
    }

    this.sessions.delete(sessionId);
  }

  /**
   * Get the SessionBridge for a session
   */
  getBridge(sessionId: string): SessionBridge | undefined {
    return this.bridges.get(sessionId);
  }

  /**
   * Get all active session IDs
   */
  getActiveSessionIds(): string[] {
    return Array.from(this.sessions.values())
      .filter((s) => s.status === 'active')
      .map((s) => s.id);
  }

  /**
   * Get session state by ID
   */
  getSessionState(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Handle session reconnection after Daemon crash/restart
   */
  async handleReconnect(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // Update state to reconnecting
    state.status = 'reconnecting';

    try {
      // Get new MessagePort
      const port = await this.waitForMessagePort();
      if (!port) {
        throw new Error('MessagePort not available after reconnect');
      }

      // Close old bridge if exists
      const oldBridge = this.bridges.get(sessionId);
      if (oldBridge) {
        oldBridge.close();
      }

      // Create new bridge
      const bridge = new SessionBridge({
        sessionId,
        port,
        onError: (error) => {
          console.error(`[SessionManager:${sessionId}] Reconnect bridge error:`, error);
        },
      });
      this.bridges.set(sessionId, bridge);

      // Re-setup handlers
      this.setupBridgeHandlers(sessionId, bridge);

      // Restore active state
      state.status = 'active';
      state.lastActivity = Date.now();
    } catch (error) {
      state.status = 'error';
      throw error;
    }
  }

  /**
   * Wait for MessagePort to be available
   */
  private waitForMessagePort(timeoutMs = 5000): Promise<MessagePort | null> {
    return new Promise((resolve) => {
      // Check if port is already available
      const existingPort = this.getMessagePort();
      if (existingPort) {
        resolve(existingPort);
        return;
      }

      // Wait for port to become available
      const startTime = Date.now();
      const checkInterval = 100;

      const checkPort = () => {
        const port = this.getMessagePort();
        if (port) {
          resolve(port);
          return;
        }

        if (Date.now() - startTime >= timeoutMs) {
          console.warn('[SessionManager] Timeout waiting for MessagePort');
          resolve(null);
          return;
        }

        setTimeout(checkPort, checkInterval);
      };

      checkPort();
    });
  }

  /**
   * Get MessagePort from electronAPI
   * Returns null if the port is not available (uses AgentControlPortAPI under the hood)
   */
  private getMessagePort(): MessagePort | null {
    if (typeof window === 'undefined' || !window.electronAPI) {
      return null;
    }

    const api = window.electronAPI.getAgentPort?.();
    if (!api) {
      return null;
    }

    // The current AgentControlPortAPI doesn't expose the raw MessagePort directly.
    // This method returns null and requires the bridge to work with the typed API.
    // In the full MessagePort architecture, this would return the actual MessagePort.
    return null;
  }

  /**
   * Setup event handlers on a bridge to sync with store
   */
  private setupBridgeHandlers(sessionId: string, bridge: SessionBridge): void {
    // Handle text output - add as assistant message
    bridge.on('chat:text', (payload) => {
      const data = payload as { content: string };
      // Add assistant message to thread
      const threadId = this.store.activeThreadId;
      if (threadId) {
        this.store.addMessage(threadId, {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: data.content,
          timestamp: Date.now(),
        });
      }
    });

    // Handle thinking content
    bridge.on('chat:thinking', (payload) => {
      const data = payload as { content: string };
      console.log(`[SessionManager:${sessionId}] Thinking:`, data.content);
      // Thinking is typically not persisted as a message
    });

    // Handle tool use
    bridge.on('chat:tool_use', (toolUse) => {
      const tool = toolUse as ToolUsePayload;
      console.log(`[SessionManager:${sessionId}] Tool use:`, tool.name);
      // Tool uses are tracked in stream snapshot, not as messages
    });

    // Handle tool result
    bridge.on('chat:tool_result', (result) => {
      const res = result as ToolResultPayload;
      console.log(`[SessionManager:${sessionId}] Tool result:`, res.id, res.error ? `error: ${res.error}` : 'success');
      // Tool results are tracked in stream snapshot
    });

    // Handle permission requests
    bridge.on('chat:permission', (request) => {
      const permReq = request as PermissionRequestPayload;
      console.log(`[SessionManager:${sessionId}] Permission request:`, permReq.toolName);
      // Permission requests need user interaction to resolve
    });

    // Handle completion
    bridge.on('chat:done', () => {
      console.log(`[SessionManager:${sessionId}] Chat completed`);
      const state = this.sessions.get(sessionId);
      if (state) {
        state.lastActivity = Date.now();
      }
    });

    // Handle errors
    bridge.on('error', (error) => {
      console.error(`[SessionManager:${sessionId}] Bridge error:`, error);
      const state = this.sessions.get(sessionId);
      if (state) {
        state.status = 'error';
      }
    });
  }
}
