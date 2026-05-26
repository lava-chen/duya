/**
 * WikiAgentScheduler - Serialized job queue for Wiki Agent
 * Handles idempotency, retry logic, and sequential processing
 */

import { getLogger, LogComponent } from '../logging/logger.js';
import type { WikiAgentJob, ChatDonePayload, WikiAgentJobStatus } from './types.js';

const logger = getLogger();

/**
 * Configuration for the scheduler
 */
interface SchedulerConfig {
  maxRetries: number;
  retryDelayMs: number;
  transientErrorDelayMs: number;
}

const DEFAULT_CONFIG: SchedulerConfig = {
  maxRetries: 3,
  retryDelayMs: 1000,
  transientErrorDelayMs: 5000,
};

/**
 * Job processor interface
 */
export interface JobProcessor {
  process(job: WikiAgentJob): Promise<void>;
}

/**
 * Serialized job queue with idempotency and retry support
 */
export class WikiAgentScheduler {
  private queue: WikiAgentJob[] = [];
  private processing = false;
  private config: SchedulerConfig;
  private processor: JobProcessor | null = null;
  private processedKeys = new Set<string>(); // Tracks processed sessionId+turnId combinations

  constructor(config: Partial<SchedulerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Set the job processor
   */
  setProcessor(processor: JobProcessor): void {
    this.processor = processor;
  }

  /**
   * Generate unique key for idempotency check
   */
  private getJobKey(sessionId: string, turnId: string): string {
    return `${sessionId}:${turnId}`;
  }

  /**
   * Enqueue a new job from chat:done payload
   * Implements idempotency: sessionId + turnId must be unique
   */
  enqueue(payload: ChatDonePayload): WikiAgentJob {
    const jobKey = this.getJobKey(payload.sessionId, payload.turnId);

    // Check if already processed
    if (this.processedKeys.has(jobKey)) {
      logger.debug('WikiAgentScheduler: job already processed, skipping', {
        sessionId: payload.sessionId,
        turnId: payload.turnId,
      }, LogComponent.AgentProcess);
      throw new Error(`Job already processed: ${jobKey}`);
    }

    // Check if already in queue
    const existingJob = this.queue.find(
      j => j.sessionId === payload.sessionId && j.turnId === payload.turnId
    );
    if (existingJob) {
      logger.debug('WikiAgentScheduler: job already in queue, skipping', {
        sessionId: payload.sessionId,
        turnId: payload.turnId,
      }, LogComponent.AgentProcess);
      return existingJob;
    }

    const job: WikiAgentJob = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
      sessionId: payload.sessionId,
      turnId: payload.turnId,
      status: 'pending',
      payload,
      retryCount: 0,
      maxRetries: this.config.maxRetries,
      createdAt: Date.now(),
    };

    this.queue.push(job);
    logger.debug('WikiAgentScheduler: job enqueued', {
      jobId: job.id,
      sessionId: job.sessionId,
      turnId: job.turnId,
      queueLength: this.queue.length,
    }, LogComponent.AgentProcess);

    // Trigger processing
    void this.processQueue();

    return job;
  }

  /**
   * Process the queue serially
   */
  private async processQueue(): Promise<void> {
    if (this.processing) {
      return;
    }

    this.processing = true;

    while (this.queue.length > 0) {
      const job = this.queue[0];

      if (job.status === 'pending') {
        await this.executeJob(job);
      }

      // Remove completed/failed jobs from queue
      if (job.status === 'completed' || (job.status === 'failed' && job.retryCount >= job.maxRetries)) {
        this.queue.shift();
        // Mark as processed for idempotency
        this.processedKeys.add(this.getJobKey(job.sessionId, job.turnId));
      } else if (job.status === 'failed') {
        // Retry: move to end of queue with delay
        this.queue.shift();
        job.status = 'pending';
        this.queue.push(job);
        await this.delay(this.config.retryDelayMs * Math.pow(2, job.retryCount));
      }
    }

    this.processing = false;
  }

  /**
   * Execute a single job with retry logic
   */
  private async executeJob(job: WikiAgentJob): Promise<void> {
    if (!this.processor) {
      logger.error('WikiAgentScheduler: no processor set', undefined, undefined, LogComponent.AgentProcess);
      job.status = 'failed';
      job.error = 'No processor configured';
      return;
    }

    job.status = 'processing';
    job.processedAt = Date.now();

    logger.debug('WikiAgentScheduler: executing job', {
      jobId: job.id,
      sessionId: job.sessionId,
      turnId: job.turnId,
      retryCount: job.retryCount,
    }, LogComponent.AgentProcess);

    try {
      await this.processor.process(job);
      job.status = 'completed';
      logger.debug('WikiAgentScheduler: job completed', {
        jobId: job.id,
        sessionId: job.sessionId,
        turnId: job.turnId,
      }, LogComponent.AgentProcess);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isTransient = this.isTransientError(error);

      job.error = errorMessage;
      job.retryCount++;

      if (isTransient && job.retryCount < job.maxRetries) {
        logger.warn('WikiAgentScheduler: transient error, will retry', {
          jobId: job.id,
          error: errorMessage,
          retryCount: job.retryCount,
          maxRetries: job.maxRetries,
        }, LogComponent.AgentProcess);
        job.status = 'failed';
      } else {
        logger.error('WikiAgentScheduler: job failed', error instanceof Error ? error : new Error(errorMessage), {
          jobId: job.id,
          retryCount: job.retryCount,
        }, LogComponent.AgentProcess);
        job.status = 'failed';
      }
    }
  }

  /**
   * Check if an error is transient (retryable)
   */
  private isTransientError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    const transientPatterns = [
      'ECONNRESET',
      'ETIMEDOUT',
      'ECONNREFUSED',
      'ENOTFOUND',
      'EAI_AGAIN',
      'timeout',
      'rate limit',
      'too many requests',
      'service unavailable',
      'temporarily unavailable',
    ];

    const errorMessage = error.message.toLowerCase();
    return transientPatterns.some(pattern => errorMessage.includes(pattern));
  }

  /**
   * Delay utility
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get current queue status
   */
  getStatus(): { queueLength: number; processing: boolean; processedCount: number } {
    return {
      queueLength: this.queue.length,
      processing: this.processing,
      processedCount: this.processedKeys.size,
    };
  }

  /**
   * Get pending jobs
   */
  getPendingJobs(): WikiAgentJob[] {
    return this.queue.filter(j => j.status === 'pending');
  }

  /**
   * Clear all jobs (for testing)
   */
  clear(): void {
    this.queue = [];
    this.processedKeys.clear();
    this.processing = false;
  }
}

let globalScheduler: WikiAgentScheduler | null = null;

/**
 * Initialize the global WikiAgentScheduler
 */
export function initWikiAgentScheduler(config?: Partial<SchedulerConfig>): WikiAgentScheduler {
  if (!globalScheduler) {
    globalScheduler = new WikiAgentScheduler(config);
  }
  return globalScheduler;
}

/**
 * Get the global scheduler instance
 */
export function getWikiAgentScheduler(): WikiAgentScheduler | null {
  return globalScheduler;
}
