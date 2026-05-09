/**
 * MCP Status Monitoring Module
 * Tracks connection status, health checks, and error reporting for MCP servers
 */

import type { MCPConnectionStatus } from '../types.js';
import { logger } from '../utils/logger.js';

/**
 * MCP server status information
 */
export interface MCPStatusInfo {
  name: string;
  status: MCPConnectionStatus;
  toolCount: number;
  lastError?: string;
  lastConnectedAt?: number;
  retryCount: number;
}

/**
 * Status change callback type
 */
export type StatusChangeCallback = (name: string, status: MCPConnectionStatus, info: MCPStatusInfo) => void;

/**
 * MCP Status Manager
 * Manages status tracking for all MCP server connections
 */
export class MCPStatusManager {
  private statuses: Map<string, MCPStatusInfo> = new Map();
  private callbacks: StatusChangeCallback[] = [];

  /**
   * Initialize status tracking for a server
   */
  initServer(name: string): MCPStatusInfo {
    const info: MCPStatusInfo = {
      name,
      status: 'disconnected',
      toolCount: 0,
      retryCount: 0,
    };
    this.statuses.set(name, info);
    return info;
  }

  /**
   * Update server status
   */
  updateStatus(name: string, status: MCPConnectionStatus, error?: string): void {
    let info = this.statuses.get(name);
    if (!info) {
      info = this.initServer(name);
    }

    const oldStatus = info.status;
    info.status = status;

    if (status === 'connected') {
      info.lastConnectedAt = Date.now();
      info.retryCount = 0;
      info.lastError = undefined;
    } else if (status === 'error' && error) {
      info.lastError = error;
    } else if (status === 'connecting') {
      info.retryCount++;
    }

    // Only notify on actual status changes
    if (oldStatus !== status) {
      logger.debug(`[MCP Status] ${name}: ${oldStatus} -> ${status}`);
      this.notifyCallbacks(name, status, info);
    }
  }

  /**
   * Update tool count for a server
   */
  updateToolCount(name: string, count: number): void {
    const info = this.statuses.get(name);
    if (info) {
      info.toolCount = count;
    }
  }

  /**
   * Get status for a specific server
   */
  getStatus(name: string): MCPStatusInfo | undefined {
    return this.statuses.get(name);
  }

  /**
   * Get all server statuses
   */
  getAllStatuses(): MCPStatusInfo[] {
    return Array.from(this.statuses.values());
  }

  /**
   * Get count of connected servers
   */
  getConnectedCount(): number {
    return Array.from(this.statuses.values()).filter(s => s.status === 'connected').length;
  }

  /**
   * Get total tool count across all connected servers
   */
  getTotalToolCount(): number {
    return Array.from(this.statuses.values())
      .filter(s => s.status === 'connected')
      .reduce((sum, s) => sum + s.toolCount, 0);
  }

  /**
   * Check if any server has error status
   */
  hasErrors(): boolean {
    return Array.from(this.statuses.values()).some(s => s.status === 'error');
  }

  /**
   * Get servers with error status
   */
  getErrorServers(): MCPStatusInfo[] {
    return Array.from(this.statuses.values()).filter(s => s.status === 'error');
  }

  /**
   * Remove a server from tracking
   */
  removeServer(name: string): void {
    this.statuses.delete(name);
  }

  /**
   * Register a status change callback
   */
  onStatusChange(callback: StatusChangeCallback): () => void {
    this.callbacks.push(callback);
    return () => {
      const index = this.callbacks.indexOf(callback);
      if (index !== -1) {
        this.callbacks.splice(index, 1);
      }
    };
  }

  /**
   * Notify all registered callbacks of a status change
   */
  private notifyCallbacks(name: string, status: MCPConnectionStatus, info: MCPStatusInfo): void {
    for (const callback of this.callbacks) {
      try {
        callback(name, status, info);
      } catch (error) {
        logger.warn(`[MCP Status] Error in status change callback: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /**
   * Clear all tracked statuses
   */
  clear(): void {
    this.statuses.clear();
    this.callbacks = [];
  }
}

/**
 * Global status manager instance
 */
let globalStatusManager: MCPStatusManager | null = null;

export function getMCPStatusManager(): MCPStatusManager {
  if (!globalStatusManager) {
    globalStatusManager = new MCPStatusManager();
  }
  return globalStatusManager;
}

export function resetMCPStatusManager(): void {
  globalStatusManager = null;
}
