/**
 * AgentInstance - Single Agent Instance Wrapper
 *
 * Encapsulates a duyaAgent instance with event forwarding capabilities.
 * Provides an EventEmitter interface for streaming events.
 */

import { EventEmitter } from 'events';
import { duyaAgent, ChatOptions } from '../index.js';
import type { ToolResult, PermissionRequestEvent, AgentOptions, ToolUse } from '../types.js';

export interface AgentInstanceOptions {
  sessionId: string;
  agentType: string;
  providerConfig?: Pick<AgentOptions, 'apiKey' | 'baseURL' | 'model' | 'provider' | 'authStyle'>;
}

export interface AgentInstanceEvents {
  text: (delta: string) => void;
  thinking: (content: string) => void;
  tool_use: (toolUse: ToolUse) => void;
  tool_result: (result: ToolResult) => void;
  permission: (request: PermissionRequestEvent) => void;
  done: (reason?: 'completed' | 'aborted' | 'max_turns' | 'error') => void;
  error: (error: Error) => void;
  retry: (info: { attempt: number; maxAttempts: number; delayMs: number; message: string }) => void;
  skill_review_started: () => void;
  skill_review_completed: (data: { passed: boolean; score: number; feedback: string; skillName?: string; error?: string }) => void;
}

// Re-export ToolUse for convenience
export type { ToolUse } from '../types.js';

export class AgentInstance extends EventEmitter {
  readonly sessionId: string;
  readonly agentType: string;
  private duyaAgent?: duyaAgent;
  private isRunning = false;
  private abortController?: AbortController;
  private providerConfig?: AgentInstanceOptions['providerConfig'];
  private pendingPermissions = new Map<string, (approved: boolean) => void>();

  constructor(sessionId: string, agentType: string, providerConfig?: AgentInstanceOptions['providerConfig']) {
    super();
    this.sessionId = sessionId;
    this.agentType = agentType;
    this.providerConfig = providerConfig;
  }

  /**
   * Start agent execution with a prompt
   */
  async start(prompt: string, options?: ChatOptions): Promise<void> {
    if (this.isRunning) {
      throw new Error(`Agent instance ${this.sessionId} is already running`);
    }

    if (!this.providerConfig?.apiKey) {
      throw new Error(`Agent instance ${this.sessionId} requires providerConfig with apiKey`);
    }

    this.isRunning = true;
    this.abortController = new AbortController();

    try {
      // Create duyaAgent instance with provider config
      this.duyaAgent = new duyaAgent({
        apiKey: this.providerConfig.apiKey,
        model: this.providerConfig.model,
        baseURL: this.providerConfig.baseURL,
        authStyle: this.providerConfig.authStyle,
        provider: this.providerConfig.provider,
        sessionId: this.sessionId,
        skillNudgeInterval: 10,
        communicationPlatform: 'duya-app',
      });

      // Create permission callback that forwards to event emitter
      const requestPermission = options?.requestPermission || this.createRequestPermissionCallback();

      // Subscribe to duyaAgent events and forward them
      const eventGen = this.duyaAgent.streamChat(prompt, {
        ...options,
        requestPermission,
      });

      for await (const event of eventGen) {
        switch (event.type) {
          case 'text':
            this.emit('text', event.data);
            break;
          case 'thinking':
            this.emit('thinking', event.data);
            break;
          case 'tool_use':
            this.emit('tool_use', event.data);
            break;
          case 'tool_result':
            this.emit('tool_result', event.data);
            break;
          case 'permission_request':
            this.emit('permission', event.data);
            break;
          case 'done':
            this.emit('done', event.reason);
            return;
          case 'error':
            this.emit('error', new Error(event.data));
            this.emit('done', 'error');
            return;
          case 'system':
            // Handle retry events from the retry mechanism
            if (event.metadata?.retryAttempt !== undefined) {
              this.emit('retry', {
                attempt: event.metadata.retryAttempt,
                maxAttempts: event.metadata.maxAttempts ?? 10,
                delayMs: event.metadata.retryDelayMs ?? 0,
                message: event.data,
              });
            }
            break;
          case 'tool_progress':
          case 'tool_timeout':
          case 'turn_start':
          case 'context_usage':
          case 'result':
            // These events are informational, no need to emit them as specific events
            break;
          case 'skill_review_started':
            this.emit('skill_review_started');
            break;
          case 'skill_review_completed':
            this.emit('skill_review_completed', event.data);
            break;
        }
      }
    } catch (error) {
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
      this.emit('done', 'error');
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Create default request permission callback that stores pending permissions
   */
  private createRequestPermissionCallback(): (request: PermissionRequestEvent) => Promise<'allow' | 'deny'> {
    return (request: PermissionRequestEvent) => {
      return new Promise<'allow' | 'deny'>((resolve) => {
        // Store the pending permission with its resolve function
        this.pendingPermissions.set(request.id, (approved: boolean) => {
          resolve(approved ? 'allow' : 'deny');
        });

        // Emit the permission event
        this.emit('permission', request);

        // Auto-timeout after 5 minutes
        setTimeout(() => {
          if (this.pendingPermissions.has(request.id)) {
            this.pendingPermissions.delete(request.id);
            resolve('deny');
          }
        }, 5 * 60 * 1000);
      });
    };
  }

  /**
   * Stop current execution
   */
  stop(): void {
    if (this.duyaAgent && this.isRunning) {
      this.duyaAgent.interrupt();
      this.isRunning = false;
    }
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  /**
   * Check if agent is currently running
   */
  get running(): boolean {
    return this.isRunning;
  }

  /**
   * Get the underlying duyaAgent instance
   */
  getAgent(): duyaAgent | undefined {
    return this.duyaAgent;
  }

  /**
   * Resolve a pending permission request
   */
  resolvePermission(requestId: string, approved: boolean): void {
    const pending = this.pendingPermissions.get(requestId);
    if (pending) {
      this.pendingPermissions.delete(requestId);
      pending(approved);
    }
  }
}

export default AgentInstance;
