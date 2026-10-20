import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import type { PluginAppInvocationResult, PluginAppMcpDescriptor } from '@duya/agent-protocol';
import type { RunOrchestrator } from '@duya/host/run-orchestrator';
import type { WorkerManager } from './worker-manager';
import type { DesktopPluginAppServerRequest, DesktopPluginAppServerResponse, DesktopPluginAppServerResult } from '../plugin-app-server-rpc';

type Pending = {
  readonly sessionId: string;
  readonly child: ChildProcess;
  readonly runId: string;
  readonly epoch: number;
  readonly operation: 'describe-tools' | 'invoke-tool';
  readonly resolve: (value: PluginAppMcpDescriptor[] | PluginAppInvocationResult) => void;
  readonly reject: (reason: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

/** Finite Main→Agent Server bridge, fenced by the live run and worker process. */
export class DesktopPluginAppServerBridge {
  readonly #orchestrator: RunOrchestrator;
  readonly #workers: WorkerManager;
  readonly #workerGenerations = new WeakMap<ChildProcess, string>();
  readonly #exitListeners = new WeakSet<ChildProcess>();
  readonly #pending = new Map<string, Pending>();

  constructor(orchestrator: RunOrchestrator, workers: WorkerManager) {
    this.#orchestrator = orchestrator;
    this.#workers = workers;
  }

  async handle(request: DesktopPluginAppServerRequest): Promise<DesktopPluginAppServerResponse> {
    try {
      switch (request.operation) {
        case 'current-attempt': {
          const attempt = this.#currentAttempt(request.sessionId);
          return this.#ok(request.requestId, { attempt: attempt ? { runId: attempt.runId, epoch: attempt.epoch, workerGeneration: attempt.workerGeneration } : null });
        }
        case 'validate-attempt': {
          const current = this.#currentAttempt(request.sessionId);
          return this.#ok(request.requestId, { current: current?.runId === request.runId && current.epoch === request.epoch && current.workerGeneration === request.workerGeneration });
        }
        case 'describe-tools': {
          const attempt = this.#currentAttempt(request.sessionId);
          if (!attempt || attempt.runId !== request.runId || attempt.epoch !== request.epoch) throw new Error('plugin_app_session_not_running');
          const tools = await this.#requestWorker(request.sessionId, attempt.child, request.runId, request.epoch, 'describe-tools', {
            type: 'plugin-app:describe-tools', sessionId: request.sessionId, runId: request.runId,
            epoch: request.epoch, requestId: randomUUID(),
          });
          if (!Array.isArray(tools)) throw new Error('plugin_app_worker_response_invalid');
          return this.#ok(request.requestId, { tools, workerGeneration: attempt.workerGeneration });
        }
        case 'invoke-tool': {
          const attempt = this.#currentAttempt(request.sessionId);
          if (!attempt || attempt.runId !== request.runId || attempt.epoch !== request.epoch || attempt.workerGeneration !== request.workerGeneration) {
            throw new Error('plugin_app_worker_replaced');
          }
          const result = await this.#requestWorker(request.sessionId, attempt.child, request.runId, request.epoch, 'invoke-tool', {
            type: 'plugin-app:invoke', sessionId: request.sessionId, runId: request.runId,
            epoch: request.epoch, requestId: randomUUID(), bindingId: request.bindingId,
            nonce: request.nonce, toolId: request.toolId, schemaRevision: request.schemaRevision,
            capabilityId: request.capabilityId, arguments: request.arguments,
          });
          if (!result || typeof result !== 'object' || !('ok' in result)) throw new Error('plugin_app_worker_response_invalid');
          return this.#ok(request.requestId, { result });
        }
      }
    } catch (error) {
      return { type: 'desktop-plugin-app:response', requestId: request.requestId, success: false,
        error: { code: error instanceof Error && error.message.startsWith('plugin_app_') ? error.message : 'plugin_app_worker_unavailable', message: error instanceof Error ? error.message : String(error) } };
    }
  }

  handleWorkerMessage(sessionId: string, message: Record<string, unknown>, child: ChildProcess): boolean {
    if ((message.type !== 'plugin-app:tools' && message.type !== 'plugin-app:result') || typeof message.requestId !== 'string') return false;
    const pending = this.#pending.get(message.requestId);
    if (!pending) return true;
    if (pending.child !== child || pending.sessionId !== sessionId || message.sessionId !== sessionId ||
        message.runId !== pending.runId || message.epoch !== pending.epoch || this.#workers.getWorker(sessionId) !== child) return true;
    this.#pending.delete(message.requestId);
    clearTimeout(pending.timer);
    if (message.type === 'plugin-app:tools' && pending.operation === 'describe-tools' && Array.isArray(message.tools)) {
      pending.resolve(message.tools as PluginAppMcpDescriptor[]);
    } else if (message.type === 'plugin-app:result' && pending.operation === 'invoke-tool' && message.result && typeof message.result === 'object') {
      pending.resolve(message.result as PluginAppInvocationResult);
    } else {
      pending.reject(new Error('plugin_app_worker_response_invalid'));
    }
    return true;
  }

  workerExited(child: ChildProcess): void {
    for (const [id, pending] of this.#pending) {
      if (pending.child !== child) continue;
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(new Error('plugin_app_worker_unavailable'));
    }
  }

  #currentAttempt(sessionId: string): { runId: string; epoch: number; workerGeneration: string; child: ChildProcess } | null {
    const runId = this.#orchestrator.runForSession(sessionId);
    const attempt = runId ? this.#orchestrator.attemptFor(runId) : null;
    if (!runId || !attempt) return null;
    const child = this.#workers.getWorker(sessionId);
    if (!child || child.killed || child.exitCode !== null) return null;
    let workerGeneration = this.#workerGenerations.get(child);
    if (!workerGeneration) {
      workerGeneration = randomUUID();
      this.#workerGenerations.set(child, workerGeneration);
    }
    return { runId, epoch: attempt.epoch, workerGeneration, child };
  }

  #requestWorker(
    sessionId: string,
    child: ChildProcess,
    runId: string,
    epoch: number,
    operation: Pending['operation'],
    command: Record<string, unknown>,
  ): Promise<PluginAppMcpDescriptor[] | PluginAppInvocationResult> {
    if (this.#workers.getWorker(sessionId) !== child) return Promise.reject(new Error('plugin_app_worker_replaced'));
    const requestId = command.requestId as string;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error('plugin_app_worker_timeout'));
      }, operation === 'invoke-tool' ? 330_000 : 30_000);
      this.#pending.set(requestId, { sessionId, child, runId, epoch, operation, resolve, reject, timer });
      if (!this.#exitListeners.has(child)) {
        this.#exitListeners.add(child);
        child.once('exit', () => this.workerExited(child));
      }
      if (child.killed || child.exitCode !== null || this.#workers.getWorker(sessionId) !== child) {
        this.#pending.delete(requestId);
        clearTimeout(timer);
        reject(new Error('plugin_app_worker_unavailable'));
        return;
      }
      if (!this.#workers.sendCommand(sessionId, command)) {
        this.#pending.delete(requestId);
        clearTimeout(timer);
        reject(new Error('plugin_app_worker_unavailable'));
      }
    });
  }

  #ok(requestId: string, result: DesktopPluginAppServerResult): DesktopPluginAppServerResponse {
    return { type: 'desktop-plugin-app:response', requestId, success: true, result };
  }
}
