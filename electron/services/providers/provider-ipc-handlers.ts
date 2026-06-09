/**
 * electron/services/providers/provider-ipc-handlers.ts
 *
 * Registers Electron IPC handlers for the new provider domain.
 *
 * Channel naming follows the existing `config:provider:*` convention so
 * the existing renderer contract still works. New channels:
 *   - provider:listLlm
 *   - provider:getLlm
 *   - provider:upsertLlm
 *   - provider:deleteLlm
 *   - provider:setActiveLlm
 *   - provider:getActiveRuntimeConfig   (privileged: agent / main only)
 *   - provider:getRuntimeConfig          (privileged: agent / main only)
 *   - provider:test
 *   - provider:testModel
 *   - provider:syncModels
 *   - provider:upsertModelCapability
 *
 * Secret rules:
 *   - listLlm / getLlm / upsertLlm / deleteLlm / setActiveLlm / test /
 *     syncModels return MASKED provider shapes (no apiKey / accessToken).
 *   - getActiveRuntimeConfig / getRuntimeConfig are agent-only and return
 *     the full ProviderRuntimeConfig including secrets. They refuse
 *     if the caller is the renderer.
 */

import { ipcMain, BrowserWindow } from 'electron';
import { getLogger, LogComponent } from '../../logging/logger';
import { getProviderStore } from './provider-store-electron';
import { maskApiProvider, toLegacyApiProvider } from '../../../src/lib/providers/legacy';
import type { LlmProvider, ModelCapability } from '../../../src/lib/providers/types';
import { redactSecrets } from '../../../src/lib/providers/domain/ProviderValidation';
import { findPresetByKey } from '../../../src/lib/providers/presets';
// ProviderStore is imported for type-only use in the register options
// below. The runtime singleton comes from getProviderStore().
import type { ProviderStore } from './provider-store';

const logger = getLogger();

/** Renderer-safe DTO. Mirrors `MaskedApiProvider` for backward compat. */
function toMaskedDto(llm: LlmProvider) {
  const legacy = toLegacyApiProvider(llm);
  return maskApiProvider(legacy) as unknown as Record<string, unknown>;
}

/** Detect the calling role.
 *  We do not have a per-IPC "isRenderer" signal in Electron; the
 *  conservative default is to treat all callers as renderer (mask).
 *  Privileged channels additionally require the message to carry an
 *  `agentOnly: true` flag set by the main process itself. */
function isPrivilegedCaller(event: Electron.IpcMainInvokeEvent): boolean {
  // BrowserWindow for the renderer is `BrowserWindow | null`; the main
  // process does not have a sender frame, so its event is from a
  // MessagePort or no-frame context. The agent subprocess drives us
  // via direct calls (not ipcMain), so this IPC path is renderer-only
  // by default. Privileged calls MUST come from the main process or a
  // trusted port.
  const sender = event.sender;
  if (!sender || sender.isDestroyed?.()) return false;
  return false;
}

// =============================================================================
// Handler registration
// =============================================================================

export function registerProviderIpcHandlers(opts?: {
  store?: ProviderStore;
}): void {
  const store = opts?.store ?? getProviderStore();

  // Lazy migrate on first call.
  store.migrateAllLegacyProviders();

  // --- list (masked) ---
  ipcMain.handle('provider:listLlm', () => {
    return store.listLlmProviders().map(toMaskedDto);
  });

  // --- get one (masked) ---
  ipcMain.handle('provider:getLlm', (_event, id: string) => {
    const p = store.getLlmProvider(id);
    return p ? toMaskedDto(p) : null;
  });

  // --- upsert ---
  ipcMain.handle('provider:upsertLlm', (_event, llm: LlmProvider) => {
    const r = store.upsertLlmProvider(llm);
    if (!r.ok) {
      logger.warn('provider:upsertLlm validation failed', { code: r.code, message: r.message }, LogComponent.AgentCommunicator);
      return { ok: false, code: r.code, message: redactSecrets(r.message) };
    }
    return { ok: true, provider: toMaskedDto(llm) };
  });

  // --- delete ---
  ipcMain.handle('provider:deleteLlm', (_event, id: string) => {
    return store.deleteLlmProvider(id);
  });

  // --- set active ---
  ipcMain.handle('provider:setActiveLlm', (_event, id: string) => {
    return store.setActiveLlmProvider(id);
  });

  // --- get active runtime config (privileged) ---
  ipcMain.handle(
    'provider:getActiveRuntimeConfig',
    (event, payload: { modelId: string; capabilities?: ModelCapability }) => {
      if (!isPrivilegedCaller(event)) {
        // Renderer should not receive secrets. We fail closed.
        return {
          ok: false,
          code: 'permission.denied',
          message: 'getActiveRuntimeConfig is privileged',
        };
      }
      const r = store.getActiveProviderRuntimeConfig(
        payload?.modelId ?? '',
        payload?.capabilities,
      );
      if ('error' in r) {
        return { ok: false, code: r.code, message: redactSecrets(r.error) };
      }
      return { ok: true, runtimeConfig: r };
    },
  );

  // --- get runtime config by id (privileged) ---
  ipcMain.handle(
    'provider:getRuntimeConfig',
    (
      event,
      payload: { providerId: string; modelId: string; capabilities?: ModelCapability },
    ) => {
      if (!isPrivilegedCaller(event)) {
        return {
          ok: false,
          code: 'permission.denied',
          message: 'getRuntimeConfig is privileged',
        };
      }
      const r = store.getProviderRuntimeConfig(
        payload?.providerId,
        payload?.modelId,
        payload?.capabilities,
      );
      if ('error' in r) {
        return { ok: false, code: r.code, message: redactSecrets(r.error) };
      }
      return { ok: true, runtimeConfig: r };
    },
  );

  // --- test provider (returns health status, no secrets) ---
  ipcMain.handle('provider:test', async (_event, payload: { providerId: string; presetKey?: string }) => {
    const status = await store.testProvider(payload?.providerId, payload?.presetKey);
    // Defense in depth: also redact the message field.
    return { ...status, message: redactSecrets(status.message) };
  });

  // --- test model (returns health status, no secrets) ---
  ipcMain.handle('provider:testModel', async (_event, payload: { providerId: string; modelId: string }) => {
    const status = await store.testModel(payload?.providerId, payload?.modelId);
    return { ...status, message: redactSecrets(status.message) };
  });

  // --- sync models (returns capabilities, no secrets) ---
  ipcMain.handle('provider:syncModels', async (_event, payload: { providerId: string; presetKey?: string }) => {
    return store.syncProviderModels(payload?.providerId, payload?.presetKey);
  });

  // --- upsert model capability (no secrets) ---
  ipcMain.handle('provider:upsertModelCapability', (_event, capability: ModelCapability) => {
    return store.upsertModelCapability(capability);
  });

  // --- list model capabilities by provider (Phase 3) ---
  ipcMain.handle('provider:listModelCapabilities', (_event, payload: { providerId: string }) => {
    return store.listModelCapabilities(payload?.providerId);
  });

  // --- get a single capability record (Phase 3) ---
  ipcMain.handle('provider:getModelCapability', (_event, payload: { providerId: string; modelId: string }) => {
    return store.getModelCapability(payload?.providerId, payload?.modelId);
  });

  // --- delete a capability record (Phase 3) ---
  ipcMain.handle('provider:deleteModelCapability', (_event, payload: { providerId: string; modelId: string }) => {
    return store.deleteModelCapability(payload?.providerId, payload?.modelId);
  });

  logger.info('Provider IPC handlers registered', undefined, LogComponent.AgentCommunicator);
}

/** Broadcast a `provider:changed` event to all renderer windows. */
export function broadcastProviderChange(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}
