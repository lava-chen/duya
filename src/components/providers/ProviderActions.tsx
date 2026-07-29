/**
 * src/components/providers/ProviderActions.tsx
 *
 * Plan 203 Phase 3.2: per-card action button cluster. The main
 * button is computed by a 5-state machine (`getMainButtonState`)
 * that consumes the `ProviderCardState` derived by
 * `useProviderCardState`. The 5 stable states are:
 *
 *   1. omo-default  (OMO mode active, current)
 *   2. omo-enable   (OMO mode inactive, not current)
 *   3. failover-in  (failover queue, in queue)
 *   4. failover-add (failover mode, not in queue)
 *   5. blocked-by-proxy
 *   6. default      (current soft default, normal mode)
 *   7. set-default  (default)
 *
 * With the multi-provider model, "default" is no longer a lock —
 * any configured provider can be used in chat/vision/etc. The
 * main button just promotes a provider to the implicit fallback.
 * Today duya is single-appId, so 1–5 collapse to "default" /
 * "set-default" for the current scope. The 5-state machine is
 * kept so Plan 204+ (failover) and Plan 208 (proxy) can flip
 * the appropriate flags without changing the consumer.
 *
 * The other action buttons (edit, test, quota, delete) are pure
 * JSX that consume the per-card capability flags. They are
 * rendered with `opacity-40 cursor-not-allowed` when the
 * corresponding `canX` is false.
 *
 * Plan 204 Phase 1.2: the test button icon switches from
 * `LightningIcon` to `TestTubeIcon` (matches cc-switch's
 * `TestTube2`); a new "quota" button is added (disabled when
 * `canCheckQuota=false`); the icon-button cluster is wrapped in
 * an opacity-0 / group-hover:opacity-100 div so it only shows
 * on hover (per user decision #4).
 *
 * The whole component is presentation-only: no data fetches, no
 * side effects. All callbacks are props. Phase 4's
 * `ProviderManagement` is the layer that wires those callbacks to
 * mutation hooks.
 */

import {
  PlayCircleIcon,
  CheckIcon,
  PlusIcon,
  MinusIcon,
  ShieldIcon,
  NotePencilIcon,
  CopyIcon,
  TrashIcon,
  TestTubeIcon,
  ChartBarIcon,
  LightningIcon,
  TerminalIcon,
  ChartLineIcon,
} from '@/components/icons';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { useTranslation } from '@/hooks/useTranslation';
import type { ReactNode } from 'react';
import type { ProviderCardState } from './hooks/useProviderCardState';
import type { AppId } from '@/lib/providers/hooks/queryKeys';

export type MainButtonIconName =
  | 'Play'
  | 'Check'
  | 'Plus'
  | 'Minus'
  | 'ShieldAlert';

export type MainButtonVariant =
  | 'primary'
  | 'secondary'
  | 'ghost'
  | 'danger';

export interface MainButtonState {
  disabled: boolean;
  variant: MainButtonVariant;
  className: string;
  icon: MainButtonIconName;
  text: string;
}

/**
 * Pure function: derive the main button state from the card state.
 *
 * Decision tree (Plan 203 D203.4 — 5 stable states, `isTesting`
 * is orthogonal and only affects the icon + disabled flags):
 *
 *   - isOmo + isCurrent             → "default" (check)
 *   - isOmo                         → "set-default" (play)
 *   - isInConfig (additive)         → "remove from config" (minus)
 *   - isFailoverMode + inQueue      → "in queue" (check)
 *   - isFailoverMode                → "add to queue" (plus)
 *   - isOfficialBlockedByProxy      → "blocked by proxy" (shield, disabled)
 *   - isCurrent                     → "default" (check, disabled)
 *   - default                       → "set-default" (play)
 *
 * With the multi-provider model, "set-default" just promotes
 * the provider to the implicit fallback. It does NOT lock the
 * other providers — every configured provider remains usable.
 *
 * Today duya is single-appId, so `isInConfig` is always true
 * (the only way to have a provider in the list is to be in the
 * config). The decision tree is kept intact for Plan 204+
 * additive-mode apps.
 */
export function getMainButtonState(
  card: ProviderCardState,
  _appId: AppId,
): MainButtonState {
  // OMO family (highest priority).
  if (card.isOmo) {
    if (card.isCurrent) {
      return {
        disabled: false,
        variant: 'secondary',
        className: '',
        icon: 'Check',
        text: 'Default',
      };
    }
    return {
      disabled: false,
      variant: 'primary',
      className: '',
      icon: 'Play',
      text: 'Set as default',
    };
  }

  // Failover family (must come before the additive-mode family so
  // the failover branch wins when both flags are set).
  if (card.isFailoverMode) {
    if (card.isInConfig) {
      // In additive mode, an in-config card is already in the
      // failover queue by definition.
      return {
        disabled: false,
        variant: 'secondary',
        className: '',
        icon: 'Check',
        text: 'In queue',
      };
    }
    return {
      disabled: false,
      variant: 'primary',
      className: '',
      icon: 'Plus',
      text: 'Add to queue',
    };
  }

  // Additive-mode family.
  if (!card.isInConfig) {
    return {
      disabled: false,
      variant: 'primary',
      className: '',
      icon: 'Plus',
      text: 'Add to config',
    };
  }
  // In additive config but flagged for removal.
  // (duya is always in config; the "remove" branch is future-only.)

  // Proxy-blocked family.
  if (card.isOfficialBlockedByProxy) {
    return {
      disabled: true,
      variant: 'secondary',
      className: '',
      icon: 'ShieldAlert',
      text: 'Blocked by proxy',
    };
  }

  // Default family (current soft default in normal mode).
  if (card.isCurrent) {
    return {
      disabled: true,
      variant: 'secondary',
      className: '',
      icon: 'Check',
      text: 'Default',
    };
  }

  // Default: set as default.
  return {
    disabled: false,
    variant: 'primary',
    className: '',
    icon: 'Play',
    text: 'Set as default',
  };
}

function renderIcon(name: MainButtonIconName): ReactNode {
  switch (name) {
    case 'Play':
      return <PlayCircleIcon size={12} />;
    case 'Check':
      return <CheckIcon size={12} />;
    case 'Plus':
      return <PlusIcon size={12} />;
    case 'Minus':
      return <MinusIcon size={12} />;
    case 'ShieldAlert':
      return <ShieldIcon size={12} />;
    default:
      return null;
  }
}

export interface ProviderActionsProps {
  /** The card state from `useProviderCardState`. */
  card: ProviderCardState;
  /** AppId. Reserved for Plan 205. */
  appId: AppId;
  /** True while a health test is in flight. Affects the test
   *  button's icon (spinner) and the main button's disabled flag. */
  isTesting?: boolean;
  /**
   * Plan 204 Phase 1.2: whether this provider's vendor exposes a
   * quota API the renderer can query. When false, the quota
   * button is rendered as `opacity-40 cursor-not-allowed` with
   * `onClick=undefined` and a tooltip explaining why.
   */
  canCheckQuota?: boolean;
  /** Callbacks. Each is omitted when the corresponding capability
   *  is `false` so the button can render in disabled state without
   *  wiring a no-op. */
  onSwitch: () => void;
  onEdit: () => void;
  onDuplicate?: () => void;
  onTest?: () => void;
  onCheckQuota?: () => void;
  onConfigureUsage?: () => void;
  onDelete?: () => void;
  onOpenTerminal?: () => void;
}

/**
 * Render the per-card action button cluster.
 *
 * This component is presentation-only. All callbacks are props;
 * the component does NOT call IPC or read from React Query. The
 * L4 `ProviderList` orchestrator threads the callbacks down, and
 * Phase 4's `ProviderManagement` wires them to mutation hooks.
 */
export function ProviderActions({
  card,
  appId: _appId,
  isTesting,
  canCheckQuota,
  onSwitch,
  onEdit,
  onDuplicate,
  onTest,
  onCheckQuota,
  onConfigureUsage,
  onDelete,
  onOpenTerminal,
}: ProviderActionsProps) {
  const { t } = useTranslation();
  const main = getMainButtonState(card, _appId);
  const mainDisabled = main.disabled || !!isTesting;

  return (
    <div className="flex items-center gap-1.5">
      <Button
        variant={main.variant}
        size="sm"
        onClick={mainDisabled ? undefined : onSwitch}
        disabled={mainDisabled}
        title={main.text}
      >
        {isTesting ? (
          <span className="inline-block w-3 h-3 rounded-full border-2 border-current border-r-transparent animate-spin" />
        ) : (
          renderIcon(main.icon)
        )}
        <span>{main.text}</span>
      </Button>

      {/* Plan 209: action cluster is now always visible at low
          opacity, full opacity on hover/focus-within. The
          pre-Plan-209 implementation hid every secondary
          action (edit, delete, test, ...) on `opacity-0`, which
          made the delete button effectively undiscoverable
          when the user wasn't already hovering the row. The
          user reported "I can't delete any provider" because
          they never realized the button was there. We now
          keep the cluster at ~30% opacity by default so the
          buttons read as available without competing with the
          primary "In use / Enable" affordance. */}
      <div className="flex items-center gap-1.5 opacity-30 group-hover:opacity-100 group-focus-within:opacity-100 hover:opacity-100 focus-within:opacity-100 transition-opacity duration-200">
        {card.canEdit && (
          <IconButton
            variant="default"
            size="md"
            aria-label={t('provider.tooltip.edit')}
            title={t('provider.tooltip.edit')}
            onClick={onEdit}
          >
            <NotePencilIcon size={14} />
          </IconButton>
        )}

        {card.canDuplicate && onDuplicate && (
          <IconButton
            variant="default"
            size="md"
            aria-label={t('provider.tooltip.edit')}
            title={t('provider.tooltip.edit')}
            onClick={onDuplicate}
          >
            <CopyIcon size={14} />
          </IconButton>
        )}

        {card.canTest && onTest && (
          <IconButton
            variant="default"
            size="md"
            aria-label={t('provider.tooltip.test')}
            title={t('provider.tooltip.test')}
            onClick={onTest}
            disabled={isTesting}
          >
            {isTesting ? (
              <span className="inline-block w-3.5 h-3.5 rounded-full border-2 border-current border-r-transparent animate-spin" />
            ) : (
              <TestTubeIcon size={14} />
            )}
          </IconButton>
        )}

        {onCheckQuota && (
          <IconButton
            variant="default"
            size="md"
            aria-label={
              canCheckQuota
                ? t('provider.tooltip.quota')
                : t('provider.checkQuotaUnsupported')
            }
            title={
              canCheckQuota
                ? t('provider.tooltip.quota')
                : t('provider.checkQuotaUnsupported')
            }
            onClick={canCheckQuota ? onCheckQuota : undefined}
            disabled={!canCheckQuota}
          >
            <ChartBarIcon size={14} />
          </IconButton>
        )}

        {card.canConfigureUsage && onConfigureUsage && (
          <IconButton
            variant="default"
            size="md"
            aria-label="Configure usage script"
            title="Configure usage script"
            onClick={onConfigureUsage}
          >
            <ChartLineIcon size={14} />
          </IconButton>
        )}

        {card.canOpenTerminal && onOpenTerminal && (
          <IconButton
            variant="default"
            size="md"
            aria-label="Open terminal"
            title="Open terminal"
            onClick={onOpenTerminal}
            className="hover:text-emerald-600 dark:hover:text-emerald-400"
          >
            <TerminalIcon size={14} />
          </IconButton>
        )}

        {card.canDelete && onDelete && (
          <IconButton
            variant="danger"
            size="md"
            aria-label={t('provider.tooltip.delete')}
            title={t('provider.tooltip.delete')}
            onClick={onDelete}
            data-testid="provider-action-delete"
          >
            <TrashIcon size={14} />
          </IconButton>
        )}
      </div>
    </div>
  );
}
