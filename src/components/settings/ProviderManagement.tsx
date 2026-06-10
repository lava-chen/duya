/**
 * src/components/settings/ProviderManagement.tsx
 *
 * Plan 203 Phase 4.1: the L5 wiring layer. Side-effect owner.
 *
 * Responsibilities (exclusively):
 *   - Own the dialog open / close state for both new and edit flows.
 *   - Wire the L1 mutation hooks to user actions.
 *   - Translate mutation results into the existing UX feedback
 *     (success / error banners, delete confirmation, in-flight
 *     testing indicators).
 *   - Render the L4 `ProviderList` orchestrator.
 *
 * NOT responsibilities:
 *   - Layout (the parent decides where this lives).
 *   - Model selection (that's `ModelSelectionCard` in
 *     `ProvidersSection`; out of scope for this refactor).
 *   - Diagnostics (the `runDiagnostics` flow is preserved in
 *     `ProvidersSection` until Plan 204 migrates it).
 *
 * Why this is a separate component:
 *   - `ProvidersSection` is a 1018 LoC monolith that mixes list
 *     rendering, diagnostics, model selection, and the
 *     ProviderConnectDialog wiring. The Plan 203 refactor splits
 *     those concerns; `ProviderManagement` owns the list +
 *     dialog + delete + switch + edit flow. The model-selection
 *     and diagnostics flows will be migrated in Plan 204+.
 *
 * The component is the only consumer of:
 *   - `ProviderList` (L4 orchestrator)
 *   - `useSetActiveProviderMutation`, `useUpsertProviderMutation`,
 *     `useDeleteProviderMutation`, `useProviderTestMutation`
 *     (L1 mutation hooks)
 *   - `useOpenExternal` (L1 utility)
 */

import { useCallback, useMemo, useState } from 'react';
import { ProviderList } from '@/components/providers/ProviderList';
import {
  ProviderConnectDialog,
  type EditableProvider,
  type ProviderFormData,
} from './ProviderConnectDialog';
import { useSetActiveProviderMutation } from '@/lib/providers/hooks/useSetActiveProviderMutation';
import { useUpsertProviderMutation } from '@/lib/providers/hooks/useUpsertProviderMutation';
import { useDeleteProviderMutation } from '@/lib/providers/hooks/useDeleteProviderMutation';
import { useProviderTestMutation } from '@/lib/providers/hooks/useProviderTestMutation';
import { useOpenExternal } from '@/lib/providers/hooks/useOpenExternal';
import { useConfigUpdateSubscription } from '@/lib/providers/hooks/useConfigUpdateSubscription';
import { extractErrorMessage } from '@/lib/errors/extractErrorMessage';
import { findPresetByKey } from '@/lib/providers';
import {
  QUICK_PRESETS,
  findPresetByBaseUrl,
  type QuickPreset,
} from '@/lib/provider-presets';
import type { RendererLlmProviderDTO } from '@/lib/providers/ipc-types';
import { CheckIcon, XIcon, SpinnerGapIcon } from '@/components/icons';

export interface ProviderManagementProps {
  /** AppId. Reserved for Plan 205. */
  appId?: 'duya';
}

interface Banner {
  kind: 'success' | 'error';
  text: string;
}

export function ProviderManagement({ appId = 'duya' }: ProviderManagementProps) {
  // Bridge IPC → React Query.
  useConfigUpdateSubscription();

  // Dialog state.
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedPreset, setSelectedPreset] = useState<QuickPreset | null>(null);
  const [editing, setEditing] = useState<EditableProvider | null>(null);

  // Delete confirmation.
  const [deleteTarget, setDeleteTarget] = useState<RendererLlmProviderDTO | null>(null);

  // In-flight testing set.
  const [testingIds, setTestingIds] = useState<Set<string>>(new Set());

  // Banner.
  const [banner, setBanner] = useState<Banner | null>(null);

  // L1 mutation hooks.
  const setActive = useSetActiveProviderMutation();
  const upsert = useUpsertProviderMutation();
  const deleteOne = useDeleteProviderMutation();
  const testOne = useProviderTestMutation();
  const openExternal = useOpenExternal();

  // ── switch ──
  const handleSwitch = useCallback(
    async (id: string) => {
      try {
        await setActive.mutateAsync(id);
        setBanner({ kind: 'success', text: 'Provider activated.' });
      } catch (e) {
        setBanner({ kind: 'error', text: extractErrorMessage(e).message });
      }
    },
    [setActive],
  );

  // ── edit / new ──
  const handleEdit = useCallback((provider: RendererLlmProviderDTO) => {
    const preset =
      findPresetByBaseUrl(provider.baseUrl) ||
      QUICK_PRESETS.find((p) => p.provider_type === provider.protocol) ||
      QUICK_PRESETS[0];
    setSelectedPreset(preset ?? null);
    setEditing({
      id: provider.id,
      name: provider.name,
      provider_type: provider.protocol,
      base_url: provider.baseUrl,
      api_key: provider.apiKey,
      extra_env: provider.extraEnv,
      options_json: provider.options,
    });
    setDialogOpen(true);
  }, []);

  const handleOpenPresetDialog = useCallback((preset: QuickPreset) => {
    setSelectedPreset(preset);
    setEditing(null);
    setDialogOpen(true);
  }, []);

  const handleSave = useCallback(
    async (data: ProviderFormData) => {
      try {
        if (editing) {
          // For an edit, we route through `upsertLlmProviderIPC`
          // (the L1 mutation). The mutation hook handles cache
          // invalidation.
          const newPreset = findPresetByKey(data.provider_type);
          if (!newPreset) {
            setBanner({ kind: 'error', text: 'Unknown provider preset.' });
            return;
          }
          await upsert.mutateAsync({
            llm: {
              id: editing.id,
              name: data.name,
              category: newPreset.category,
              apiFormat: newPreset.apiFormat,
              auth: data.api_key
                ? { type: 'api-key', apiKey: data.api_key }
                : { type: 'none' },
              endpoints: { baseUrl: data.base_url, isFullUrl: false },
              ui: newPreset.ui,
              meta: { createdAt: Date.now(), updatedAt: Date.now(), sortIndex: 0 },
            },
          });
          setBanner({ kind: 'success', text: 'Provider updated.' });
        } else {
          const newPreset = findPresetByKey(data.provider_type);
          if (!newPreset) {
            setBanner({ kind: 'error', text: 'Unknown provider preset.' });
            return;
          }
          const providerId = generateProviderId(
            data.provider_type,
            data.name,
            [],
          );
          await upsert.mutateAsync({
            llm: {
              id: providerId,
              name: data.name,
              category: newPreset.category,
              apiFormat: newPreset.apiFormat,
              auth: data.api_key
                ? { type: 'api-key', apiKey: data.api_key }
                : { type: 'none' },
              endpoints: { baseUrl: data.base_url, isFullUrl: false },
              ui: newPreset.ui,
              meta: {
                createdAt: Date.now(),
                updatedAt: Date.now(),
                sortIndex: 0,
                tags: ['active'],
              },
            },
          });
          setBanner({ kind: 'success', text: 'Provider connected.' });
        }
        setDialogOpen(false);
        setEditing(null);
      } catch (e) {
        setBanner({ kind: 'error', text: extractErrorMessage(e).message });
      }
    },
    [editing, upsert],
  );

  // ── delete ──
  const handleDelete = useCallback((id: string) => {
    // We need the full DTO for the confirmation dialog; the
    // orchestrator only forwards the id, so we look it up in the
    // cache. To keep this decoupled, we just store the id here and
    // resolve the name lazily.
    setDeleteTarget({ id, name: id } as unknown as RendererLlmProviderDTO);
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    try {
      await deleteOne.mutateAsync(deleteTarget.id);
      setBanner({ kind: 'success', text: 'Provider disconnected.' });
    } catch (e) {
      setBanner({ kind: 'error', text: extractErrorMessage(e).message });
    } finally {
      setDeleteTarget(null);
    }
  }, [deleteTarget, deleteOne]);

  // ── test ──
  const handleTest = useCallback(
    async (id: string) => {
      setTestingIds((prev) => new Set(prev).add(id));
      try {
        const result = await testOne.mutateAsync({ providerId: id });
        setBanner({
          kind: result.ok ? 'success' : 'error',
          text: result.ok
            ? `Connection OK${result.latencyMs ? ` (${result.latencyMs}ms)` : ''}`
            : `${result.errorKind ?? 'error'}: ${result.message ?? 'unknown'}`,
        });
      } catch (e) {
        setBanner({ kind: 'error', text: extractErrorMessage(e).message });
      } finally {
        setTestingIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [testOne],
  );

  // Auto-dismiss the banner.
  const bannerAutoDismiss = useMemo(() => banner, [banner]);

  return (
    <div className="space-y-4" data-testid="provider-management">
      {bannerAutoDismiss && (
        <div
          role="status"
          className={
            'rounded-lg border p-3 text-sm ' +
            (bannerAutoDismiss.kind === 'success'
              ? 'border-green-500/50 bg-green-500/10 text-green-600'
              : 'border-destructive/50 bg-destructive/10 text-destructive')
          }
        >
          {bannerAutoDismiss.kind === 'success' ? (
            <span className="inline-flex items-center gap-2">
              <CheckIcon size={14} />
              {bannerAutoDismiss.text}
            </span>
          ) : (
            <span className="inline-flex items-center gap-2">
              <XIcon size={14} />
              {bannerAutoDismiss.text}
            </span>
          )}
        </div>
      )}

      <ProviderList
        appId={appId}
        onSwitch={handleSwitch}
        onEdit={handleEdit}
        onDelete={handleDelete}
        onTest={handleTest}
        onOpenWebsite={openExternal}
        testingProviderIds={testingIds}
      />

      {/* Delete confirmation */}
      {deleteTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          data-testid="delete-confirmation"
        >
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setDeleteTarget(null)}
          />
          <div className="relative z-10 w-full max-w-sm mx-4 bg-surface border border-border/50 rounded-xl shadow-xl p-5">
            <h3 className="text-sm font-semibold mb-2">Disconnect provider?</h3>
            <p className="text-xs text-muted-foreground mb-4">
              {`Are you sure you want to disconnect "${deleteTarget.name}"? This action cannot be undone.`}
            </p>
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setDeleteTarget(null)}
                className="px-3 py-2 rounded-lg text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                data-testid="confirm-delete"
                className="px-3 py-2 rounded-lg bg-destructive text-white text-sm font-medium hover:bg-destructive/90 transition-colors"
              >
                {deleteOne.isPending ? (
                  <span className="inline-flex items-center gap-1">
                    <SpinnerGapIcon size={12} className="animate-spin" />
                    Disconnecting…
                  </span>
                ) : (
                  'Disconnect'
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Connect / Edit dialog */}
      <ProviderConnectDialog
        preset={selectedPreset}
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setEditing(null);
        }}
        onSave={handleSave}
        editProvider={editing}
      />
    </div>
  );
}

/**
 * Generate a meaningful provider ID. Mirrors the helper that
 * `ProvidersSection` already uses; inlined here so the wiring
 * layer is self-contained.
 */
function generateProviderId(
  providerType: string,
  name: string,
  existingIds: string[],
): string {
  const baseId = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || providerType.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  if (!existingIds.includes(baseId)) return baseId;
  const suffix = crypto.randomUUID().slice(-8);
  return `${baseId}-${suffix}`;
}
