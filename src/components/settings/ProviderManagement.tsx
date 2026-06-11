/**
 * src/components/settings/ProviderManagement.tsx
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
 *   - The delete confirmation modal is gone too — `ProviderEditView`
 *     dispatches a `duya:provider-delete` window event when the
 *     user clicks delete on an edit page; this component listens
 *     and routes to `useDeleteProviderMutation`.
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
 *   - `DefaultProviderSection` (settings UI to pick the soft default)
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ProviderList } from '@/components/providers/ProviderList';
import { ProviderAddButton } from '@/components/providers/ProviderAddButton';
import { DefaultProviderSection } from './DefaultProviderSection';
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

  // Listen for delete events emitted by `ProviderEditView` when
  // the user clicks the delete button on the edit page. We need
  // a custom event here because the edit page is rendered
  // elsewhere (different component tree branch) and doesn't have
  // a direct prop path to this component.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ id: string }>).detail;
      if (detail?.id) {
        void doDelete(detail.id);
      }
    };
    window.addEventListener('duya:provider-delete', handler);
    return () => window.removeEventListener('duya:provider-delete', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      if (!target) return;
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

      <DefaultProviderSection appId={appId} />
    </div>
  );
}
