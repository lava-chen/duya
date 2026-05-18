import { ipcMain } from 'electron';
import { testProviderConnection, TestProviderBody } from '../services/network/provider-tester';
import { fetchOllamaModels } from '../services/network/model-detector';
import { testBridgeChannel } from '../services/network/bridge-tester';
import { startWeixinQrLogin, pollWeixinQrStatus, cancelWeixinQrSession } from '../services/network/wechat-qr';
import { getLogger, LogComponent } from '../logging/logger';

export { testBridgeChannel } from '../services/network/bridge-tester';
export { testProviderConnection, TestProviderBody, ConnectionTestResult } from '../services/network/provider-tester';

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

  getLogger().info('Registered network IPC handlers', undefined, LogComponent.NetHandlers);
}