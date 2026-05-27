import { BrowserWindow } from 'electron';
import { getLogger, LogComponent } from '../logging/logger.js';
import { getJsonSetting } from '../db/queries/settings.js';
import { WikiAgentObserver } from './WikiAgentObserver.js';
import { WikiAgentProcessor } from './WikiAgentProcessor.js';
import { WikiAgentScheduler } from './WikiAgentScheduler.js';
import type {
  ChatDonePayload,
  WikiAgentActivityEvent,
  WikiAgentRuntimePhase,
  WikiAgentRuntimeStatus,
} from './types.js';

const logger = getLogger();

class WikiAgentRuntime {
  private readonly scheduler = new WikiAgentScheduler();
  private readonly observer = new WikiAgentObserver(this.scheduler);
  private readonly processor = new WikiAgentProcessor((payload, phase, message, details) => {
    this.recordActivity(payload, phase, message, details);
  });
  private status: WikiAgentRuntimeStatus = {
    observerActive: false,
    queueLength: 0,
    processing: false,
    processedCount: 0,
    phase: 'idle',
  };

  constructor() {
    this.scheduler.setProcessor(this.processor);
    this.observer.start();
    this.status.observerActive = true;
    this.refreshStatus();
  }

  private isEnabled(): boolean {
    return getJsonSetting<boolean>('wikiAgentEnabled', false);
  }

  handleChatDone(payload: ChatDonePayload): void {
    if (!this.isEnabled()) {
      return;
    }

    try {
      const accepted = this.observer.onChatDone(payload);
      if (!accepted) {
        logger.debug(
          'WikiAgent duplicate chat:done ignored',
          { sessionId: payload.sessionId, turnId: payload.turnId },
          LogComponent.Main,
        );
        this.refreshStatus();
        return;
      }

      this.recordActivity(payload, 'queued', 'Queued completed turn for WikiAgent');
      this.refreshStatus('queued');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.recordActivity(payload, 'error', message);
      throw error;
    }
  }

  getStatus(): WikiAgentRuntimeStatus {
    return { ...this.status };
  }

  private recordActivity(
    payload: ChatDonePayload,
    phase: WikiAgentRuntimePhase,
    message: string,
    details?: Record<string, unknown>,
  ): void {
    const timestamp = Date.now();
    const event: WikiAgentActivityEvent = {
      sessionId: payload.sessionId,
      turnId: payload.turnId,
      phase,
      timestamp,
      message,
      details,
    };

    this.refreshStatus(phase, message);
    if (phase === 'completed') {
      this.status.lastCompletedAt = timestamp;
    }
    if (phase === 'error') {
      this.status.lastError = message;
    }

    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('wiki:activity', event);
      }
    }

    logger.info(
      `WikiAgent ${phase}: ${message}`,
      { sessionId: payload.sessionId, turnId: payload.turnId, details },
      LogComponent.Main,
    );
  }

  private refreshStatus(phase?: WikiAgentRuntimePhase, message?: string): void {
    const schedulerStatus = this.scheduler.getStatus();
    this.status = {
      ...this.status,
      observerActive: this.observer.isActive,
      queueLength: schedulerStatus.queueLength,
      processing: schedulerStatus.processing,
      processedCount: schedulerStatus.processedCount,
      phase: phase ?? this.status.phase,
      lastActivityAt: Date.now(),
      lastActivityMessage: message ?? this.status.lastActivityMessage,
    };

    if (!schedulerStatus.processing && schedulerStatus.queueLength === 0 && this.status.phase !== 'error') {
      this.status.phase = phase === 'completed' ? 'completed' : 'idle';
    }
  }
}

let runtime: WikiAgentRuntime | null = null;

export function initWikiAgentRuntime(): WikiAgentRuntime {
  if (!runtime) {
    runtime = new WikiAgentRuntime();
  }

  return runtime;
}

export function getWikiAgentRuntime(): WikiAgentRuntime | null {
  return runtime;
}
