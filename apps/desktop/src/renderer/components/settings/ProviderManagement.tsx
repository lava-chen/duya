/**
 * apps/desktop/src/renderer/components/settings/ProviderManagement.tsx
 *
 * Plan 205: the L5 wiring layer for the provider list. Renders
 * the connected providers list, handles list-level mutations
 * (switch default, delete, test), and exposes a one-click "Add
 * provider" header button that navigates to the inline
 * `provider-picker` sub-view.
 *
 * Plan 205 changes:
 *   - The legacy `ProviderConnectDialog` is gone. The add / edit
 *     flows are now separate pages (`ProviderPickerView` →
 *     `ProviderEditView`), dispatched via the settings-tab
 *     store.
 *   - The delete confirmation modal is gone too. Each delete entry point
 *     owns its own confirm and calls `useDeleteProviderMutation` directly;
 *     `ProviderEditView` (a separate component-tree branch) no longer
 *     relies on a window event that this component may not be mounted
 *     to receive.
 *   - The save / open logic is centralized in the
 *     `useProviderEditSave` hook (consumed by `ProviderEditView`).
 *
 * The component is the only consumer of:
 *   - `ProviderList` (L4 orchestrator)
 *   - `useSetDefaultProviderMutation`, `useDeleteProviderMutation`,
 *     `useProviderTestMutation` (L1 mutation hooks)
 *   - `useOpenExternal` (L1 utility)
 *   - `ProviderAddButton` (right-aligned entry into the picker)
 *   - `ProviderEmptyState` (rendered when the list is empty)
 *
 * Note: `DefaultProviderSection` was removed — the provider list
 * already exposes the same "promote to default" affordance per
 * row, so the standalone section beneath the list was a
 * duplicate.
 */

import { useCallback, useMemo, useState } from 'react';
import { ProviderList } from '@/components/providers/ProviderList';
import { ProviderAddButton } from '@/components/providers/ProviderAddButton';
import { useSetDefaultProviderMutation } from '@/lib/providers/hooks/useSetDefaultProviderMutation';
import { useDeleteProviderMutation } from '@/lib/providers/hooks/useDeleteProviderMutation';
import { useProviderTestMutation } from '@/lib/providers/hooks/useProviderTestMutation';
import { useOpenExternal } from '@/lib/providers/hooks/useOpenExternal';
import { useConfigUpdateSubscription } from '@/lib/providers/hooks/useConfigUpdateSubscription';
import { useProvidersQuery } from '@/lib/providers/hooks/useProvidersQuery';
import { extractErrorMessage } from '@/lib/errors/extractErrorMessage';
import type { RendererLlmProviderDTO } from '@/lib/providers/ipc-types';
import { CheckIcon, XIcon, SpinnerGapIcon } from '@/components/icons';
import { useTranslation } from '@/hooks/useTranslation';
import { useDefaultProviderId } from '@/components/providers/hooks/useDefaultProviderId';
import { useConversationStore } from '@/stores/conversation-store';

export interface ProviderManagementProps {
  /** AppId. Reserved for Plan 205. */
  appId?: 'duya';
}

interface Banner {
  kind: 'success' | 'error';
  text: string;
}

export function ProviderManagement({ appId = 'duya' }: ProviderManagementProps) {
  const { t, locale } = useTranslation();
  // Bridge IPC → React Query.
  useConfigUpdateSubscription();

  // In-flight testing set.
  const [testingIds, setTestingIds] = useState<Set<string>>(new Set());

  // Banner.
  const [banner, setBanner] = useState<Banner | null>(null);

  // L1 mutation hooks.
  const setDefault = useSetDefaultProviderMutation(appId);
  const deleteOne = useDeleteProviderMutation();
  const testOne = useProviderTestMutation();
  const openExternal = useOpenExternal();
  const enterProviderEdit = useConversationStore((s) => s.enterProviderEdit);
  const { data: providers = [] } = useProvidersQuery();
  // Plan 209: the delete dialog needs to know the default
  // provider id so it can warn the user when they're about
  // to delete the provider that is currently the default.
  const defaultId = useDefaultProviderId(appId);

  // ── switch (set the soft default) ──
  const handleSwitch = useCallback(
    async (id: string) => {
      try {
        await setDefault.mutateAsync(id);
        setBanner({ kind: 'success', text: t('settings.providers.activated') });
      } catch (e) {
        setBanner({ kind: 'error', text: extractErrorMessage(e).message });
      }
    },
    [setDefault, t],
  );

  // ── edit (jump to provider-edit page with the id) ──
  const handleEdit = useCallback(
    (provider: RendererLlmProviderDTO) => {
      enterProviderEdit({ providerId: provider.id });
    },
    [enterProviderEdit],
  );

  // ── delete ──
  const doDelete = useCallback(
    async (id: string) => {
      const target = providers.find((p) => p.id === id);
      if (!target) {
        // Never fail silently: a missing row means the list is cold or
        // stale, and returning here looked identical to a successful
        // delete from the user's side.
        setBanner({
          kind: 'error',
          text:
            locale === 'zh'
              ? '找不到要删除的服务商，请刷新后重试。'
              : 'Could not find the provider to delete. Refresh and try again.',
        });
        return;
      }
      // Plan 209: when the user deletes the current default
      // provider, the system would be left with no default
      // provider at all. Confirm explicitly so the user
      // doesn't hit the delete button by accident and end
      // up unable to chat. We keep the dialog text in
      // sync with `ProviderEditView.handleDelete` so the
      // two entry points feel consistent.
      const isActive = target.isDefault || target.isActive || defaultId === id;
      if (typeof window !== 'undefined' && isActive) {
        const ok = window.confirm(
          locale === 'zh'
            ? `"${target.name}" 是当前的默认服务商。删除后需要重新选择或添加一个服务商才能继续对话。是否继续？`
            : `"${target.name}" is the current default provider. After deletion you will need to pick or add a new provider to continue chatting. Continue?`,
        );
        if (!ok) return;
      }
      try {
        await deleteOne.mutateAsync(id);
        setBanner({
          kind: 'success',
          text: `${target.name} ${t('settings.providers.disconnected')}`,
        });
      } catch (e) {
        setBanner({ kind: 'error', text: extractErrorMessage(e).message });
      }
    },
    [providers, deleteOne, t, defaultId, locale],
  );

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
          className={`settings-status-banner ${bannerAutoDismiss.kind === 'success' ? 'success' : 'error'}`}
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

      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-foreground">
          {t('settings.providers.connectedProviders')}
        </h2>
        <ProviderAddButton />
      </div>

      <ProviderList
        appId={appId}
        onSwitch={handleSwitch}
        onEdit={handleEdit}
        onDelete={doDelete}
        onTest={handleTest}
        onOpenWebsite={openExternal}
        testingProviderIds={testingIds}
      />
    </div>
  );
}
