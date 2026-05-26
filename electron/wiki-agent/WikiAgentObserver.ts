/**
 * WikiAgentObserver - Global observer for chat:done events
 * Captures all session completion events and routes them to the scheduler
 */

import { getLogger, LogComponent } from '../logging/logger.js';
import type { ChatDonePayload } from './types.js';
import type { WikiAgentScheduler } from './WikiAgentScheduler.js';

const logger = getLogger();

/**
 * Observer for chat:done events across all sessions
 */
export class WikiAgentObserver {
  private scheduler: WikiAgentScheduler;
  private isStarted = false;

  constructor(scheduler: WikiAgentScheduler) {
    this.scheduler = scheduler;
  }

  /**
   * Start observing chat:done events
   */
  start(): void {
    if (this.isStarted) {
      logger.debug('WikiAgentObserver already started', undefined, LogComponent.AgentProcess);
      return;
    }

    this.isStarted = true;
    logger.info('WikiAgentObserver started', undefined, LogComponent.AgentProcess);
  }

  /**
   * Stop observing events
   */
  stop(): void {
    this.isStarted = false;
    logger.info('WikiAgentObserver stopped', undefined, LogComponent.AgentProcess);
  }

  /**
   * Handle chat:done event from any session
   * Called by message bus when chat:done is received
   */
  onChatDone(payload: ChatDonePayload): void {
    if (!this.isStarted) {
      logger.debug('WikiAgentObserver not started, ignoring chat:done', { sessionId: payload.sessionId }, LogComponent.AgentProcess);
      return;
    }

    logger.debug('WikiAgentObserver received chat:done', {
      sessionId: payload.sessionId,
      turnId: payload.turnId,
      contentLength: payload.finalContent.length,
    }, LogComponent.AgentProcess);

    // Enqueue the job for processing
    this.scheduler.enqueue(payload);
  }

  /**
   * Check if observer is active
   */
  get isActive(): boolean {
    return this.isStarted;
  }
}

let globalObserver: WikiAgentObserver | null = null;

/**
 * Initialize the global WikiAgentObserver
 */
export function initWikiAgentObserver(scheduler: WikiAgentScheduler): WikiAgentObserver {
  if (!globalObserver) {
    globalObserver = new WikiAgentObserver(scheduler);
  }
  return globalObserver;
}

/**
 * Get the global observer instance
 */
export function getWikiAgentObserver(): WikiAgentObserver | null {
  return globalObserver;
}
