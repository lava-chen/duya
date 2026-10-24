import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import type { PluginAppInvocationResult, PluginAppMcpDescriptor, PluginAppResourceRead } from '@duya/agent-protocol';
import type { RunOrchestrator } from '@duya/host/run-orchestrator';
import type { WorkerManager } from './worker-manager';
import type { DesktopPluginAppServerRequest, DesktopPluginAppServerResponse, DesktopPluginAppServerResult } from '../plugin-app-server-rpc';

type Pending = {
  readonly sessionId: string;
  readonly child: ChildProcess;
  readonly runId?: string;
  readonly epoch?: number;
  readonly workerGeneration: number;
  readonly operation: 'describe-tools' | 'invoke-tool' | 'read-resource';
  readonly resolve: (value: PluginAppMcpDescriptor[] | PluginAppInvocationResult | PluginAppResourceRead) => void;
  readonly reject: (reason: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

/**
 * Finite Main→Agent Server bridge, fenced by the session worker and generation.
 *
 * Tool requests are bound to the live orchestrator attempt (`runId`, `epoch`),
 * worker process (`child`) and worker generation. Read-only resource requests
 * can run while a chat is idle, so they bind to the live session worker and
 * generation instead. Replies from a superseded worker are dropped.
 */
export class DesktopPluginAppServerBridge {
  readonly #orchestrator: RunOrchestrator;
  readonly #workers: WorkerManager;
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
          const tools = await this.#requestWorker(request.sessionId, attempt.child, attempt.runId, attempt.epoch, attempt.workerGeneration, 'describe-tools', {
            type: 'plugin-app:describe-tools', sessionId: request.sessionId, runId: attempt.runId,
            epoch: attempt.epoch, requestId: randomUUID(),
          });
          if (!Array.isArray(tools)) throw new Error('plugin_app_worker_response_invalid');
          return this.#ok(request.requestId, { tools, workerGeneration: attempt.workerGeneration });
        }
        case 'invoke-tool': {
          const attempt = this.#currentAttempt(request.sessionId);
          if (!attempt || attempt.runId !== request.runId || attempt.epoch !== request.epoch || attempt.workerGeneration !== request.workerGeneration) {
            throw new Error('plugin_app_worker_replaced');
          }
          const result = await this.#requestWorker(request.sessionId, attempt.child, attempt.runId, attempt.epoch, attempt.workerGeneration, 'invoke-tool', {
            type: 'plugin-app:invoke', sessionId: request.sessionId, runId: attempt.runId,
            epoch: attempt.epoch, requestId: randomUUID(), bindingId: request.bindingId,
            nonce: request.nonce, toolId: request.toolId, schemaRevision: request.schemaRevision,
            capabilityId: request.capabilityId, arguments: request.arguments,
          });
          if (!result || typeof result !== 'object' || !('ok' in result)) throw new Error('plugin_app_worker_response_invalid');
          return this.#ok(request.requestId, { result });
        }
        case 'read-resource': {
          if (typeof request.pluginId !== 'string' || typeof request.server !== 'string' ||
              typeof request.resourceUri !== 'string' || !request.resourceUri.startsWith('ui://')) {
            throw new Error('plugin_app_resource_request_invalid');
          }
          const worker = this.#currentWorker(request.sessionId);
          if (!worker) throw new Error('plugin_app_worker_unavailable');
          const resource = await this.#requestWorker(
            request.sessionId, worker.child, undefined, undefined, worker.workerGeneration, 'read-resource', {
              type: 'plugin-app:read-resource', sessionId: request.sessionId, requestId: randomUUID(),
              pluginId: request.pluginId, server: request.server, resourceUri: request.resourceUri,
            },
          );
          if (!resource || typeof resource !== 'object' || !('contents' in resource)) {
            throw new Error('plugin_app_worker_response_invalid');
          }
          return this.#ok(request.requestId, { resource: resource as PluginAppResourceRead, workerGeneration: worker.workerGeneration });
        }
      }
    } catch (error) {
      return { type: 'desktop-plugin-app:response', requestId: request.requestId, success: false,
        error: { code: error instanceof Error && error.message.startsWith('plugin_app_') ? error.message : 'plugin_app_worker_unavailable', message: error instanceof Error ? error.message : String(error) } };
    }
  }

  handleWorkerMessage(sessionId: string, message: Record<string, unknown>, child: ChildProcess): boolean {
    if ((message.type !== 'plugin-app:tools' && message.type !== 'plugin-app:result' &&
        message.type !== 'plugin-app:resource') || typeof message.requestId !== 'string') return false;
    const pending = this.#pending.get(message.requestId);
    // A reply with no pending request is a late answer to a request that was
    // already settled or timed out. It is consumed here so it cannot fall
    // through to another handler, and it settles nothing.
    if (!pending) return true;
    if (pending.child !== child || pending.sessionId !== sessionId || message.sessionId !== sessionId ||
        (pending.operation !== 'read-resource' &&
          (message.runId !== pending.runId || message.epoch !== pending.epoch)) ||
        this.#workers.getWorker(sessionId) !== child ||
        this.#workers.workerGeneration(sessionId) !== pending.workerGeneration) return true;
    this.#pending.delete(message.requestId);
    clearTimeout(pending.timer);
    if (message.type === 'plugin-app:tools' && pending.operation === 'describe-tools' && Array.isArray(message.tools)) {
      pending.resolve(message.tools as PluginAppMcpDescriptor[]);
    } else if (message.type === 'plugin-app:result' && pending.operation === 'invoke-tool' && message.result && typeof message.result === 'object') {
      pending.resolve(message.result as PluginAppInvocationResult);
    } else if (message.type === 'plugin-app:resource' && pending.operation === 'read-resource' &&
        message.result && typeof message.result === 'object') {
      pending.resolve(message.result as PluginAppResourceRead);
    } else if (message.type === 'plugin-app:resource' && pending.operation === 'read-resource' &&
        typeof message.error === 'string') {
      pending.reject(new Error(message.error));
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

  /**
   * The live attempt for a session, or `null` when there is none.
   *
   * `runId` and `epoch` come from the orchestrator, which owns the run
   * ledger; `child` and `workerGeneration` come from the worker supervisor,
   * which owns the worker processes. A retired attempt is not a live one, and
   * a session whose worker has exited has no live worker to talk to.
   */
  #currentAttempt(sessionId: string): { runId: string; epoch: number; workerGeneration: number; child: ChildProcess } | null {
    const runId = this.#orchestrator.runForSession(sessionId);
    const attempt = runId ? this.#orchestrator.attemptFor(runId) : null;
    if (!runId || !attempt || attempt.retired) return null;
    const child = this.#workers.getWorker(sessionId);
    if (!child || child.killed || child.exitCode !== null) return null;
    const workerGeneration = this.#workers.workerGeneration(sessionId);
    if (workerGeneration === null) return null;
    return { runId, epoch: attempt.epoch, workerGeneration, child };
  }

  #currentWorker(sessionId: string): { workerGeneration: number; child: ChildProcess } | null {
    const child = this.#workers.getWorker(sessionId);
    if (!child || child.killed || child.exitCode !== null) return null;
    const workerGeneration = this.#workers.workerGeneration(sessionId);
    return workerGeneration === null ? null : { workerGeneration, child };
  }

  #requestWorker(
    sessionId: string,
    child: ChildProcess,
    runId: string | undefined,
    epoch: number | undefined,
    workerGeneration: number,
    operation: Pending['operation'],
    command: Record<string, unknown>,
  ): Promise<PluginAppMcpDescriptor[] | PluginAppInvocationResult | PluginAppResourceRead> {
    if (this.#workers.getWorker(sessionId) !== child) return Promise.reject(new Error('plugin_app_worker_replaced'));
    const requestId = command.requestId as string;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error('plugin_app_worker_timeout'));
      }, operation === 'invoke-tool' ? 330_000 : 30_000);
      this.#pending.set(requestId, { sessionId, child, ...(runId === undefined ? {} : { runId }), ...(epoch === undefined ? {} : { epoch }), workerGeneration, operation, resolve, reject, timer });
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
