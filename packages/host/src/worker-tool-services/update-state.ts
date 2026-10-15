import type {
  BotIdentityPatchPayload,
  MemoryTierBridgeResponse,
  MemoryTierWritePayload,
  UpdateStateContext,
  UpdateStatePort,
} from '@duya/capabilities/UpdateStateTool/ports';

interface MainRpcResponse {
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

type MainRpcRequest = (
  channel: string,
  payload: unknown,
  options?: { timeout?: number },
) => Promise<MainRpcResponse>;

function resolveMainRpc(context?: UpdateStateContext): MainRpcRequest | undefined {
  if (!context || typeof context !== 'object') return undefined;
  const request = (context as UpdateStateContext & { ipcRequest?: unknown }).ipcRequest;
  return typeof request === 'function' ? request as MainRpcRequest : undefined;
}

function toBridgeResponse(response: MainRpcResponse): MemoryTierBridgeResponse {
  return {
    success: response.success,
    ...(response.data !== undefined ? { result: response.data } : {}),
    ...(response.error !== undefined ? { error: response.error } : {}),
  };
}

/** Bind the capability to the existing Main memory-tier and bot-identity RPCs. */
export function createWorkerUpdateStatePort(): UpdateStatePort {
  return {
    async writeMemory(payload: MemoryTierWritePayload, context) {
      const request = resolveMainRpc(context);
      if (!request) return null;
      const response = await request(
        'memory-tier:rpc',
        { action: payload.action, payload },
        { timeout: 15_000 },
      );
      return toBridgeResponse(response);
    },
    async updateIdentity(payload: BotIdentityPatchPayload, context) {
      const request = resolveMainRpc(context);
      if (!request) return null;
      const response = await request(
        'bot-identity:rpc',
        {
          subaction: payload.subaction,
          payload,
          sessionId: context?.options?.sessionId,
        },
        { timeout: 15_000 },
      );
      return toBridgeResponse(response);
    },
  };
}
