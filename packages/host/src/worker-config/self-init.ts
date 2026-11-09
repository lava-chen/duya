import { resolveProvider } from './file-config.js';

/** Minimal worker command fields needed to self-initialize a Host-spawned run. */
export interface WorkerSelfInitRequest {
  readonly sessionId: string;
  readonly manifest?: {
    readonly cwd?: string;
    readonly agent?: {
      readonly model?: string;
      readonly providerId?: string;
    };
  };
}

/** Init command shape accepted by the existing worker process entry. */
export interface WorkerSelfInitMessage {
  readonly type: 'init';
  readonly sessionId: string;
  /**
   * Marks the command as the worker's OWN resolution of the run's frozen
   * selection. An `init` from the agent server carries no marker: the two are
   * not the same thing, because only this one may be rebuilt from the
   * manifest when a later run selects a different model.
   */
  readonly origin: 'self-init';
  readonly providerConfig: {
    readonly apiKey: string;
    readonly baseURL?: string;
    readonly model: string;
    readonly provider: 'anthropic' | 'openai';
    readonly authStyle: 'api_key';
    /**
     * The provider the selection actually resolved to. The worker needs it to
     * tell whether the running agent is still bound to the provider the run
     * names: the protocol discriminator alone cannot, because two providers
     * can speak the same protocol.
     */
    readonly providerId?: string;
  };
  readonly workingDirectory: string;
  readonly language: 'zh';
}

export type WorkerSelfInitResult =
  | { readonly ok: true; readonly message: WorkerSelfInitMessage }
  | { readonly ok: false; readonly message: string };

export interface WorkerSelfInitOptions {
  /** Test seam for reading a temporary config root. */
  readonly configRoot?: string;
  /** Worker cwd used only when the frozen manifest does not include one. */
  readonly workingDirectoryFallback?: string;
}

/**
 * Resolve the frozen provider selection and compose the init command for a
 * worker that receives `chat:start` before a Desktop-style `init` command.
 * Call this inside the worker process: the returned command contains the
 * credential, which must not be exposed to the Host control plane.
 */
export function createWorkerSelfInitMessage(
  request: WorkerSelfInitRequest,
  options: WorkerSelfInitOptions = {},
): WorkerSelfInitResult {
  const workingDirectory = request.manifest?.cwd || options.workingDirectoryFallback || process.cwd();
  const selection = request.manifest?.agent;
  const resolution = resolveProvider(
    selection?.model,
    options.configRoot,
    selection?.providerId,
  );
  if (!resolution.ok) {
    return {
      ok: false,
      message: `worker self-init could not resolve a provider: ${resolution.message}`,
    };
  }

  const provider = resolution.provider;
  return {
    ok: true,
    message: {
      type: 'init',
      origin: 'self-init',
      sessionId: request.sessionId,
      providerConfig: {
        apiKey: provider.apiKey,
        ...(provider.baseUrl ? { baseURL: provider.baseUrl } : {}),
        model: provider.model.model,
        provider: provider.protocol,
        authStyle: 'api_key',
        providerId: provider.id,
      },
      workingDirectory,
      language: 'zh',
    },
  };
}
