/**
 * src/components/providers/ProviderList.tsx
 *
 * Plan 203 Phase 3.3: the L4 orchestrator. Pure presentation:
 *
 *   1. Reads the provider list via `useProvidersQuery` (L1).
 *   2. Reads the default provider id via `useDefaultProviderId`.
 *   3. Renders a `ProviderRow` per provider. Each row calls
 *      `useProviderCardState` (L4 hook) — see `ProviderRow`.
 *   4. Each row contains the `ProviderActions` action cluster.
 *
 * Plan 204 Phase 1.1: the per-card UI is rewritten in the
 * cc-switch style — wider padding, icon in a 40x40 block, name +
 * URL block, hover-only action cluster (via the `group` class).
 * The action cluster is exposed through `ProviderActions`; this
 * orchestrator only computes the per-row derived props
 * (`canCheckQuota`).
 *
 * Plan 204 Phase 1.3: `onAdd` callback is now part of the
 * orchestrator. When the list is empty AND `onAdd` is provided,
 * `ProviderEmptyState` is rendered instead of a "no providers"
 * placeholder. When the list is non-empty, `ProviderManagement`
 * (the parent) renders the `ProviderAddButton` above the list
 * (Phase 2.3).
 *
 * All side effects live in the parent's callbacks (Phase 4's
 * `ProviderManagement`). This component is `React.memo`-able in
 * the future: the per-card state derivation is `useMemo`ed, the
 * callbacks are stable references, and the only re-render trigger
 * is the providers query data.
 *
 * The orchestrator does NOT:
 *   - Open the connect dialog (Phase 4.1's `ProviderManagement` does)
 *   - Show toasts on success / failure (Phase 4.1 does)
 *
 * Drag-reorder is intentionally NOT wired today: duya's
 * `RendererLlmProviderDTO` carries `sortOrder`, but the IPC layer
 * does not yet expose a `reorderProvidersIPC` mutation. Plan 205
 * will add it. The orchestrator accepts an optional
 * `onDragReorder` callback so the wiring is future-compatible.
 */

import { useMemo, useCallback } from 'react';
import { useProvidersQuery } from '@/lib/providers/hooks/useProvidersQuery';
import { useDefaultProviderId } from './hooks/useDefaultProviderId';
import { useProviderCardState } from './hooks/useProviderCardState';
import { useQuotaNavigation } from './hooks/useQuotaNavigation';
import { ProviderActions } from './ProviderActions';
import { ProviderEmptyState } from './ProviderEmptyState';
import { isQuotaSupported } from '@/lib/providers/canCheckQuota';
import type { AppId } from '@/lib/providers/hooks/queryKeys';
import type { RendererLlmProviderDTO } from '@/lib/providers/ipc-types';
import { SpinnerGapIcon } from '@/components/icons';
import { PresetIcon } from '@/components/settings/PresetIcon';
import { useTranslation } from '@/hooks/useTranslation';

export interface ProviderListProps {
  /** The appId binding. Reserved for Plan 205; today always 'duya'. */
  appId: AppId;
  /** Switch (set the provider as the soft default). */
  onSwitch: (id: string) => void;
  /** Open the edit dialog for the provider. */
  onEdit: (provider: RendererLlmProviderDTO) => void;
  /** Open the delete confirmation for the provider. */
  onDelete: (id: string) => void;
  /** Run a health test for the provider. Optional. */
  onTest?: (id: string) => void;
  /** Open a vendor website. */
  onOpenWebsite: (url: string) => void;
  /**
   * Plan 204 Phase 1.3: open the add-provider flow. When
   * provided AND the list is empty, `ProviderEmptyState` is
   * rendered with this callback. The parent (ProviderManagement)
   * also renders an Add button above the list regardless.
   */
  onAdd?: () => void;
  /** Set of provider ids currently being health-tested. Drives
   *  the test button's spinner + disabled state. */
  testingProviderIds?: Set<string>;
  /** Whether the proxy is taking over the live config. duya has
   *  no proxy today; this is always `false` until Plan 208. */
  isProxyTakeover?: boolean;
}

/** Per-card icon key (no JSX; the parent chooses how to render
 *  the icon set, this orchestrator just emits a string). */
function getProviderIconKey(
  providerType: string,
  baseUrl: string | undefined,
): string {
  const url = (baseUrl ?? '').toLowerCase();
  if (providerType === 'ollama' || url.includes('ollama') || url.includes('11434')) {
    return 'ollama';
  }
  if (providerType === 'openrouter' || url.includes('openrouter')) {
    return 'openrouter';
  }
  if (url.includes('bigmodel.cn') || url.includes('z.ai')) return 'zhipu';
  if (url.includes('kimi.com')) return 'kimi';
  if (url.includes('moonshot')) return 'moonshot';
  if (url.includes('minimax')) return 'minimax';
  if (url.includes('volces.com') || url.includes('volcengine')) return 'volcengine';
  if (url.includes('bailian') || url.includes('dashscope')) return 'bailian';
  if (url.includes('anthropic')) return 'anthropic';
  if (url.includes('bedrock') || url.includes('aws.amazon')) return 'bedrock';
  if (url.includes('vertex') || url.includes('googleapis')) return 'google';
  if (url.includes('deepseek')) return 'deepseek';
  if (url.includes('x.ai')) return 'xai';
  if (providerType === 'openai-compatible') return 'server';
  if (providerType === 'anthropic') return 'anthropic';
  return 'server';
}

function getPresetWebsite(
  provider: RendererLlmProviderDTO,
): string | null {
  if (provider.category === 'local') return null;
  if (!provider.baseUrl) return null;
  return provider.baseUrl;
}

/**
 * Internal: a single provider row. Lives in its own component so
 * `useProviderCardState` is called at the top level (Rules of
 * Hooks). The component is intentionally tiny: it only renders
 * the visual surface for one provider.
 *
 * Plan 204 Phase 1.1: rewritten in cc-switch style — wider
 * padding, 40x40 icon block on the left, name+URL block, and
 * the action cluster on the right with hover-only visibility
 * (driven by `ProviderActions` wrapping the icons in
 * `group-hover:opacity-100`). The card itself is `group`-tagged
 * so the hover behavior works.
 */
function ProviderRow(props: {
  provider: RendererLlmProviderDTO;
  appId: AppId;
  defaultProviderId: string | null;
  isProxyTakeover: boolean;
  isTesting: boolean;
  canCheckQuota: boolean;
  onSwitch: (id: string) => void;
  onEdit: (provider: RendererLlmProviderDTO) => void;
  onDelete: (id: string) => void;
  onTest?: (id: string) => void;
  onCheckQuota?: () => void;
  onOpenWebsite: (url: string) => void;
}) {
  const { t } = useTranslation();
  const {
    provider: p,
    appId,
    defaultProviderId,
    isProxyTakeover,
    isTesting,
    canCheckQuota,
    onSwitch,
    onEdit,
    onDelete,
    onTest,
    onCheckQuota,
    onOpenWebsite,
  } = props;
  const card = useProviderCardState({
    provider: p,
    appId,
    context: { defaultProviderId, proxyTakeover: isProxyTakeover },
  });
  const iconKey = getProviderIconKey(p.protocol, p.baseUrl);
  const website = getPresetWebsite(p);

  const handleOpenWebsite = () => {
    if (website) onOpenWebsite(website);
  };

  return (
    <div
      data-testid={`provider-card-${p.id}`}
      className={
        // Plan 205 Phase L4: the card now has a clearly tinted
        // background (`bg-surface/50` matches the duya
        // settings card), `rounded-2xl` for a softer feel, and
        // `p-5` for breathing room. The current provider gets a
        // stronger visual signal: a tinted background tint
        // (`bg-accent/[0.04]`) AND a `ring` border.
        'group relative overflow-hidden rounded-2xl border p-5 transition-all duration-200 ' +
        (card.isCurrent
          ? 'bg-accent/[0.04] border-accent/40 ring-1 ring-accent/20 shadow-sm'
          : 'bg-surface/40 border-border/50 hover:border-border-active hover:bg-surface/60 hover:shadow-sm')
      }
    >
      <div className="flex items-center gap-4">
        <div className="h-11 w-11 shrink-0 rounded-xl bg-muted flex items-center justify-center border border-border/50 group-hover:scale-105 transition-transform duration-200">
          <PresetIcon iconKey={iconKey} size={22} />
        </div>
        <div className="flex-1 min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2 min-h-5">
            <h3 className="text-[15px] font-semibold leading-none truncate text-foreground">
              {p.name}
            </h3>
            <span
              className={
                'text-[10px] px-1.5 py-0.5 rounded-md font-semibold ' +
                (p.hasApiKey
                  ? 'bg-green-500/15 text-green-700 dark:text-green-300'
                  : 'bg-yellow-500/15 text-yellow-700 dark:text-yellow-300')
              }
            >
              {p.hasApiKey ? t('provider.configured') : t('provider.noKey')}
            </span>
            {/* The "In use" state is communicated via the
                main button (disabled, check icon) and the
                card's tinted background / ring border. A
                separate badge would be redundant. */}
          </div>
          {p.notes && (
            <p
              className="text-xs text-muted-foreground/80 max-w-[280px] truncate"
              title={p.notes}
              data-testid={`provider-card-notes-${p.id}`}
            >
              {p.notes}
            </p>
          )}
          {website && (
            <button
              type="button"
              onClick={handleOpenWebsite}
              className="inline-flex items-center text-xs max-w-[280px] text-blue-500 transition-colors hover:underline dark:text-blue-400 cursor-pointer"
              title={website}
            >
              <span className="truncate">{website}</span>
            </button>
          )}
        </div>
        <ProviderActions
          card={card}
          appId={appId}
          isTesting={isTesting}
          canCheckQuota={canCheckQuota}
          onSwitch={() => onSwitch(p.id)}
          onEdit={() => onEdit(p)}
          onDelete={() => onDelete(p.id)}
          onTest={onTest ? () => onTest(p.id) : undefined}
          onCheckQuota={onCheckQuota}
        />
      </div>
    </div>
  );
}

/**
 * Default no-op handlers so the orchestrator can be mounted in
 * tests / stories without wiring the full mutation layer.
 */
const NOOP_SWITCH = () => undefined;
const NOOP_EDIT = () => undefined;
const NOOP_DELETE = () => undefined;
const NOOP_OPEN_WEBSITE = () => undefined;

export function ProviderList({
  appId,
  onSwitch = NOOP_SWITCH,
  onEdit = NOOP_EDIT,
  onDelete = NOOP_DELETE,
  onTest,
  onOpenWebsite = NOOP_OPEN_WEBSITE,
  onAdd,
  testingProviderIds,
  isProxyTakeover = false,
}: ProviderListProps) {
  const { t } = useTranslation();
  // Both `useProvidersQuery` and `useDefaultProviderId` MUST be
  // called with the same `appId` so they read from the same
  // React Query cache entry. Today duya has a single appId, so
  // either both pass `appId` or neither does — passing `appId`
  // is the future-compatible path for Plan 205.
  const { data: providers = [], isLoading } = useProvidersQuery(appId);
  const defaultId = useDefaultProviderId(appId);

  // Stable list, sorted by sortOrder. Memoized so the per-row
  // re-render is bounded to the row itself.
  const sorted = useMemo<RendererLlmProviderDTO[]>(
    () => [...providers].sort((a, b) => a.sortOrder - b.sortOrder),
    [providers],
  );

  // Stable quota navigation callback. The `useQuotaNavigation`
  // hook returns a stable reference so we can safely put it in
  // the per-row prop list without re-render churn.
  const navigateToQuota = useQuotaNavigation();

  // Compute `canCheckQuota` per provider. Memoized at the list
  // level (not per-row) to keep the per-row derivation simple.
  // When `hasApiKey` is false we still want the icon to render
  // (with a different tooltip) — keep the row consistent with
  // cc-switch, where the quota button is always visible.
  const canCheckQuotaById = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const p of sorted) {
      map.set(p.id, isQuotaSupported(p.protocol, p.baseUrl) && p.hasApiKey);
    }
    return map;
  }, [sorted]);

  const onCheckQuotaForRow = useCallback(
    (id: string) => () => {
      // The quota "action" is just navigation to the usage tab.
      // Per-row derivation is done by the orchestrator so
      // ProviderActions doesn't need to know about navigation.
      navigateToQuota();
      void id;
    },
    [navigateToQuota],
  );

  if (isLoading && providers.length === 0) {
    return (
      <div className="flex items-center justify-center gap-2 py-12">
        <SpinnerGapIcon size={18} className="animate-spin" />
        <span className="text-sm text-muted-foreground">{t('provider.loading')}</span>
      </div>
    );
  }

  if (sorted.length === 0) {
    if (onAdd) {
      return <ProviderEmptyState onAdd={onAdd} />;
    }
    return (
      <div className="px-4 py-8 text-center">
        <span className="text-sm text-muted-foreground">
          {t('provider.noProviders')}
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="provider-list">
      {sorted.map((p) => (
        <ProviderRow
          key={p.id}
          provider={p}
          appId={appId}
          defaultProviderId={defaultId}
          isProxyTakeover={isProxyTakeover}
          isTesting={testingProviderIds?.has(p.id) ?? false}
          canCheckQuota={canCheckQuotaById.get(p.id) ?? false}
          onSwitch={onSwitch}
          onEdit={onEdit}
          onDelete={onDelete}
          onTest={onTest}
          onCheckQuota={onCheckQuotaForRow(p.id)}
          onOpenWebsite={onOpenWebsite}
        />
      ))}
    </div>
  );
}
