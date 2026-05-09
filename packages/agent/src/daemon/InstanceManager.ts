/**
 * InstanceManager - Manages Agent Instances
 *
 * Provides lifecycle management for AgentInstance objects.
 */

import { AgentInstance, type AgentInstanceOptions } from './AgentInstance.js';

export class InstanceManager {
  private instances = new Map<string, AgentInstance>();

  /**
   * Create a new agent instance for a session
   */
  create(sessionId: string, agentType: string, providerConfig?: AgentInstanceOptions['providerConfig']): AgentInstance {
    const instance = new AgentInstance(sessionId, agentType, providerConfig);
    this.instances.set(sessionId, instance);
    return instance;
  }

  /**
   * Get an existing instance by session ID
   */
  get(sessionId: string): AgentInstance | undefined {
    return this.instances.get(sessionId);
  }

  /**
   * Check if an instance exists for the given session ID
   */
  has(sessionId: string): boolean {
    return this.instances.has(sessionId);
  }

  /**
   * Destroy an instance by session ID
   */
  destroy(sessionId: string): void {
    const instance = this.instances.get(sessionId);
    if (instance) {
      instance.stop();
      instance.removeAllListeners();
      this.instances.delete(sessionId);
    }
  }

  /**
   * Destroy all instances
   */
  destroyAll(): void {
    for (const sessionId of this.instances.keys()) {
      this.destroy(sessionId);
    }
  }

  /**
   * Get all active session IDs
   */
  getActiveSessions(): string[] {
    return Array.from(this.instances.keys());
  }

  /**
   * Get count of active instances
   */
  get size(): number {
    return this.instances.size;
  }
}

export default InstanceManager;
