/**
 * MCP Circuit Breaker Module
 * Implements circuit breaker pattern for MCP server connections
 * Prevents cascading failures when MCP servers are unavailable
 */

import { logger } from '../utils/logger.js';

/**
 * Circuit breaker states
 */
export type CircuitState = 'closed' | 'open' | 'half-open';

/**
 * Circuit breaker configuration
 */
export interface CircuitBreakerConfig {
  /** Number of failures before opening the circuit */
  failureThreshold: number;
  /** Time in milliseconds before attempting to close the circuit */
  resetTimeoutMs: number;
  /** Number of successful calls in half-open state to close the circuit */
  successThreshold: number;
}

/**
 * Default circuit breaker configuration
 */
export const DEFAULT_CIRCUIT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 3,
  resetTimeoutMs: 30000, // 30 seconds
  successThreshold: 2,
};

/**
 * Circuit breaker for a single MCP server
 */
export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime?: number;
  private config: CircuitBreakerConfig;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = { ...DEFAULT_CIRCUIT_CONFIG, ...config };
  }

  /**
   * Get current circuit state
   */
  getState(): CircuitState {
    // Check if we should transition from open to half-open
    if (this.state === 'open' && this.lastFailureTime) {
      const timeSinceLastFailure = Date.now() - this.lastFailureTime;
      if (timeSinceLastFailure >= this.config.resetTimeoutMs) {
        this.state = 'half-open';
        this.successCount = 0;
        logger.debug(`[CircuitBreaker] Transitioned to half-open state`);
      }
    }
    return this.state;
  }

  /**
   * Check if the circuit allows requests
   */
  canExecute(): boolean {
    const state = this.getState();
    return state === 'closed' || state === 'half-open';
  }

  /**
   * Record a successful execution
   */
  recordSuccess(): void {
    if (this.state === 'half-open') {
      this.successCount++;
      if (this.successCount >= this.config.successThreshold) {
        this.state = 'closed';
        this.failureCount = 0;
        this.successCount = 0;
        logger.debug(`[CircuitBreaker] Circuit closed after ${this.config.successThreshold} successes`);
      }
    } else if (this.state === 'closed') {
      // Reset failure count on success in closed state
      this.failureCount = 0;
    }
  }

  /**
   * Record a failed execution
   */
  recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === 'half-open') {
      // Immediately open on failure in half-open state
      this.state = 'open';
      logger.debug(`[CircuitBreaker] Circuit opened due to failure in half-open state`);
    } else if (this.state === 'closed' && this.failureCount >= this.config.failureThreshold) {
      this.state = 'open';
      logger.debug(`[CircuitBreaker] Circuit opened after ${this.failureCount} failures`);
    }
  }

  /**
   * Get current failure count
   */
  getFailureCount(): number {
    return this.failureCount;
  }

  /**
   * Reset circuit to closed state
   */
  reset(): void {
    this.state = 'closed';
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = undefined;
  }
}

/**
 * Circuit breaker manager for all MCP servers
 */
export class CircuitBreakerManager {
  private breakers: Map<string, CircuitBreaker> = new Map();

  /**
   * Get or create a circuit breaker for a server
   */
  getBreaker(name: string): CircuitBreaker {
    let breaker = this.breakers.get(name);
    if (!breaker) {
      breaker = new CircuitBreaker();
      this.breakers.set(name, breaker);
    }
    return breaker;
  }

  /**
   * Check if a server can execute requests
   */
  canExecute(name: string): boolean {
    return this.getBreaker(name).canExecute();
  }

  /**
   * Record success for a server
   */
  recordSuccess(name: string): void {
    this.getBreaker(name).recordSuccess();
  }

  /**
   * Record failure for a server
   */
  recordFailure(name: string): void {
    this.getBreaker(name).recordFailure();
  }

  /**
   * Remove a circuit breaker
   */
  removeBreaker(name: string): void {
    this.breakers.delete(name);
  }

  /**
   * Get all circuit states
   */
  getAllStates(): Array<{ name: string; state: CircuitState }> {
    return Array.from(this.breakers.entries()).map(([name, breaker]) => ({
      name,
      state: breaker.getState(),
    }));
  }

  /**
   * Clear all circuit breakers
   */
  clear(): void {
    this.breakers.clear();
  }
}

/**
 * Global circuit breaker manager instance
 */
let globalCircuitBreakerManager: CircuitBreakerManager | null = null;

export function getCircuitBreakerManager(): CircuitBreakerManager {
  if (!globalCircuitBreakerManager) {
    globalCircuitBreakerManager = new CircuitBreakerManager();
  }
  return globalCircuitBreakerManager;
}

export function resetCircuitBreakerManager(): void {
  globalCircuitBreakerManager = null;
}
