import { ipcMain } from 'electron';
import { testProviderConnection, TestProviderBody } from '../services/network/provider-tester';
import { fetchOllamaModels } from '../services/network/model-detector';
import { fetchProviderModels, FetchProviderModelsBody } from '../services/network/model-fetcher';
import { testBridgeChannel } from '../services/network/bridge-tester';
import { startWeixinQrLogin, pollWeixinQrStatus, cancelWeixinQrSession } from '../services/network/wechat-qr';
import { getProviderUsage, ProviderUsageBody } from '../services/network/provider-usage';
import { getLogger, LogComponent } from '../logging/logger';
import { isMaskedKey } from '../../src/lib/providers/secret';
import { getProviderStore } from '../services/providers/provider-store-electron';

export { testBridgeChannel } from '../services/network/bridge-tester';
export { testProviderConnection, TestProviderBody, ConnectionTestResult } from '../services/network/provider-tester';
export {
  fetchProviderModels,
  FetchProviderModelsBody,
  FetchProviderModelsResult,
  FetchedModel,
} from '../services/network/model-fetcher';

export function registerNetHandlers(): void {
  ipcMain.handle('net:provider:test', async (_event, body: TestProviderBody) => {
    try {
      return await testProviderConnection(body);
    } catch (error) {
      getLogger().error('Provider test error', error instanceof Error ? error : new Error(String(error)), undefined, LogComponent.NetHandlers);
      return {
        success: false,
        error: {
          code: 'TEST_FAILED',
          message: error instanceof Error ? error.message : '测试连接失败',
          suggestion: '请稍后重试',
        },
      };
    }
  });

  ipcMain.handle('net:provider:usage', async (_event, body: ProviderUsageBody) => {
    try {
      return await getProviderUsage(body);
    } catch (error) {
      getLogger().error('Provider usage error', error instanceof Error ? error : new Error(String(error)), undefined, LogComponent.NetHandlers);
      return {
        success: false,
        error: {
          code: 'USAGE_FETCH_FAILED',
          message: error instanceof Error ? error.message : '获取配额失败',
        },
      };
    }
  });

  ipcMain.handle('net:bridge:test', async (_event, channel: string) => {
    try {
      return await testBridgeChannel(channel);
    } catch (error) {
      getLogger().error('Bridge test error', error instanceof Error ? error : new Error(String(error)), undefined, LogComponent.NetHandlers);
      return { success: false, message: 'Connection failed', details: String(error) };
    }
  });

  ipcMain.handle('net:weixin:qr:start', async () => {
    try {
      const result = await startWeixinQrLogin();
      return { success: true, ...result };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to start QR login',
      };
    }
  });

  ipcMain.handle('net:weixin:qr:poll', async (_event, sessionId: string) => {
    try {
      const session = await pollWeixinQrStatus(sessionId);

      if (session.status === 'confirmed' || session.status === 'failed') {
        setTimeout(() => cancelWeixinQrSession(sessionId), 30_000);
      }

      return {
        success: true,
        status: session.status,
        qr_image: session.qrImage || undefined,
        account_id: session.accountId || undefined,
        error: session.error || undefined,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to poll QR status',
      };
    }
  });

  ipcMain.handle('net:weixin:qr:cancel', (_event, sessionId: string) => {
    cancelWeixinQrSession(sessionId);
    return { success: true };
  });

  ipcMain.handle('net:ollama:models', async (_event, baseUrl: string) => {
    try {
      return await fetchOllamaModels(baseUrl);
    } catch (error) {
      getLogger().error('Ollama models fetch error', error instanceof Error ? error : new Error(String(error)), undefined, LogComponent.NetHandlers);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch Ollama models',
      };
    }
  });

  // Plan 205 Phase H1: list-models endpoint used by
  // `ProviderEditView` so the user can pick a model from a
  // dropdown instead of typing a raw id.
  ipcMain.handle('net:provider:models', async (_event, body: FetchProviderModelsBody) => {
    try {
      // Plan 209 fix-up: when the renderer is editing an existing
      // provider (`provider_id` is set) and the renderer did NOT
      // supply a usable `api_key` (i.e. the user did not retype
      // their key, or the only value available is the masked
      // hint), fall back to the on-disk key. Without this the
      // fetch always 401s because the masked hint like
      // `sk-a***cdef` is never accepted upstream.
      const resolved = await resolveFetchProviderModelsBody(body);
      return await fetchProviderModels(resolved);
    } catch (error) {
      getLogger().error('Provider models fetch error', error instanceof Error ? error : new Error(String(error)), undefined, LogComponent.NetHandlers);
      return {
        success: false,
        error: {
          code: 'UNKNOWN_ERROR',
          message: error instanceof Error ? error.message : 'Failed to fetch provider models',
        },
      };
    }
  });

  getLogger().info('Registered network IPC handlers', undefined, LogComponent.NetHandlers);
}

/**
 * Plan 209 fix-up: resolve the `api_key` (and optionally
 * `base_url` / `protocol`) for a fetch-models request by falling
 * back to the on-disk provider. The renderer only ever sees the
 * masked hint, so the only way it can fetch models against an
 * existing provider is to ask the main process to look up the
 * real key.
 *
 * Resolution order (first match wins):
 *   1. `body.api_key` is a non-empty, non-masked value → use it
 *      (the user retyped their key on the edit page).
 *   2. `body.provider_id` is set and the on-disk provider has a
 *      real (non-masked) `auth.apiKey` → use the on-disk key,
 *      and fill in `base_url` / `protocol` from the same
 *      provider if the renderer didn't supply them.
 *   3. Otherwise return the body unchanged; the fetcher will
 *      short-circuit with `NO_CREDENTIALS`.
 *
 * Exported (not just module-private) so unit tests can exercise
 * the resolution logic without standing up a full ipcMain harness.
 */
export async function resolveFetchProviderModelsBody(
  body: FetchProviderModelsBody,
): Promise<FetchProviderModelsBody> {
  if (body.api_key && !isMaskedKey(body.api_key)) {
    return body;
  }
  if (!body.provider_id) {
    return body;
  }
  try {
    const stored = getProviderStore().getLlmProvider(body.provider_id);
    if (!stored?.auth?.apiKey || isMaskedKey(stored.auth.apiKey)) {
      return body;
    }
    return {
      ...body,
      api_key: stored.auth.apiKey,
      base_url: body.base_url || stored.endpoints?.baseUrl || undefined,
      protocol: body.protocol || (stored as { protocol?: string }).protocol || undefined,
    };
  } catch {
    // Store not available (e.g. in unit tests). Fall through.
    return body;
  }
}