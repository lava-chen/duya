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
  readonly providerConfig: {
    readonly apiKey: string;
    readonly baseURL?: string;
    readonly model: string;
    readonly provider: 'anthropic' | 'openai';
    readonly authStyle: 'api_key';
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
      message: userFacingProviderError(resolution),
    };
  }

  const provider = resolution.provider;
  return {
    ok: true,
    message: {
      type: 'init',
      sessionId: request.sessionId,
      providerConfig: {
        apiKey: provider.apiKey,
        ...(provider.baseUrl ? { baseURL: provider.baseUrl } : {}),
        model: provider.model.model,
        provider: provider.protocol,
        authStyle: 'api_key',
      },
      workingDirectory,
      language: 'zh',
    },
  };
}

function userFacingProviderError(
  resolution: Extract<ReturnType<typeof resolveProvider>, { ok: false }>,
): string {
  switch (resolution.reason) {
    case 'config-missing':
      return '还没有配置模型服务。输入 `/provider add` 添加服务。';
    case 'no-provider-selected':
      return '还没有选择模型服务。输入 `/provider` 选择服务，或输入 `/model` 为当前会话选择模型。';
    case 'api-key-missing':
    case 'secrets-missing':
      return '模型服务还没有 API key。输入 `/provider` 添加或更新密钥。';
    case 'model-unresolved':
      return '模型服务没有默认模型。输入 `/model` 选择模型，或在 `/provider` 设置默认模型。';
    case 'config-unreadable':
    case 'config-malformed':
    case 'provider-unknown':
    case 'secrets-malformed':
      return `模型服务配置有问题：${resolution.message}`;
  }
}
