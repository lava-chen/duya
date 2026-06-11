/**
 * src/components/providers/hooks/useProviderCardState.ts
 *
 * Plan 203 Phase 3.1: pure hook that derives the per-card boolean
 * state and per-card capability flags from a single
 * `RendererLlmProviderDTO` + the surrounding context (default id,
 * proxy takeover, etc.). The L4 `ProviderList` orchestrator calls
 * this once per card and threads the result down to `ProviderCard`
 * and `ProviderActions`.
 *
 * Why a hook and not a plain function:
 * - Future cards may want a memoized `useMemo` over context (e.g.
 *   a `useDefaultProviderId` subscription), so a hook leaves room
 *   for that without breaking the public contract.
 *
 * Why a "hook" that today is essentially a `useMemo`:
 * - The current implementation is pure. Keeping it as a hook
 *   future-proofs the per-card state without forcing an immediate
 *   migration. Once `useDefaultProviderId` starts subscribing to
 *   the providers query, the hook signature is already a hook —
 *   no refactor required.
 *
 * State fields:
 *
 *  Identity & live status:
 *   - isCurrent         : this card is the user's soft default
 *                         provider (the implicit fallback for
 *                         chat/vision/etc).
 *   - isActive          : the LlmProvider.meta.tags contains 'active'.
 *                         (Mirrors the DTO `isActive` field, kept
 *                         as a transitional alias.)
 *   - isDefault         : the DTO `isDefault` field, derived from
 *                         `AppConfig.defaultProviderId`.
 *
 *  Future dimensions (Plan 204+):
 *   - isInConfig        : additive-mode app (e.g. opencode). duya
 *                         is a single-app project, so this is
 *                         effectively always `true` until Plan 205.
 *   - isFailoverMode    : failover queue. duya has no failover
 *                         queue yet, so this is always `false`.
 *   - isProxyTakeover   : live config is managed by a proxy.
 *                         duya has no proxy; always `false` until
 *                         Plan 208.
 *   - isOfficialBlockedByProxy : official provider blocked by a
 *                         proxy. Always `false` for duya today.
 *   - isOmo             : OMO/OMO-Slim variant. duya has no OMO;
 *                         always `false`.
 *   - isReadOnly        : hermes v12+ read-only mode. duya is not
 *                         on hermes; always `false`.
 *   - isDefaultModel    : openclaw-style default model marker.
 *                         Always `false` until Plan 205.
 *
 *  Capability flags:
 *   - canEdit           : user can edit this provider. False for
 *                         read-only providers (hermes v12+).
 *   - canDelete         : user can delete. True for additive-mode
 *                         (always) and for non-current in normal
 *                         mode. False for current + normal mode.
 *   - canDuplicate      : always `true` for duya (no read-only path
 *                         is wired yet).
 *   - canTest           : always `true` for duya.
 *   - canConfigureUsage : usage-script editor (Plan 207). False
 *                         until that lands.
 *   - canOpenTerminal   : provider-local terminal (Plan 208). False
 *                         until that lands.
 *   - canSetAsDefault   : openclaw-style default model. False
 *                         until Plan 205.
 *
 * The function is intentionally side-effect-free. The tests
 * (`__tests__/useProviderCardState.test.ts`) verify that the eight
 * boolean dimensions combine orthogonally.
 */

import { useMemo } from 'react';
import type { RendererLlmProviderDTO } from '@/lib/providers/ipc-types';
import type { AppId } from '@/lib/providers/hooks/queryKeys';

export interface ProviderCardContext {
  /** ID of the user's soft default provider (the implicit
   *  fallback for chat/vision/etc). May be `null` when none. */
  defaultProviderId: string | null;
  /** Whether a proxy is taking over the live config. duya has no
   *  proxy; today this is always `false`. */
  proxyTakeover: boolean;
}

export interface ProviderCardState {
  // ── Identity & live status ──
  isCurrent: boolean;
  isActive: boolean;
  isDefault: boolean;

  // ── Future dimensions (defaults today) ──
  isInConfig: boolean;
  isFailoverMode: boolean;
  isProxyTakeover: boolean;
  isOfficialBlockedByProxy: boolean;
  isOmo: boolean;
  isReadOnly: boolean;
  isDefaultModel: boolean;

  // ── Capability flags ──
  canEdit: boolean;
  canDelete: boolean;
  canDuplicate: boolean;
  canTest: boolean;
  canConfigureUsage: boolean;
  canOpenTerminal: boolean;
  canSetAsDefault: boolean;
}

export interface UseProviderCardStateOptions {
  /** The renderer DTO for the card. */
  provider: RendererLlmProviderDTO;
  /** The appId binding. Reserved for Plan 205; today always `'duya'`. */
  appId: AppId;
  /** Surrounding context (default id, proxy takeover). */
  context: ProviderCardContext;
}

/** Pure derivation. Today this is a `useMemo` wrapper so the
 *  signature stays a hook. */
export function useProviderCardState(
  options: UseProviderCardStateOptions,
): ProviderCardState {
  const { provider, context } = options;
  return useMemo<ProviderCardState>(() => {
    const isCurrent = context.defaultProviderId === provider.id;
    const isDefault = provider.isDefault ?? false;
    const isActive = isDefault; // transitional alias
    const isReadOnly = false; // Plan 205
    const isOmo = false; // duya has no OMO concept
    const isProxyTakeover = context.proxyTakeover;
    const isInConfig = true; // single-appId: always in config
    const isFailoverMode = false; // Plan 204
    const isOfficialBlockedByProxy =
      isProxyTakeover && provider.category === 'official';
    const isDefaultModel = false; // Plan 205

    // Capability flags.
    // `canEdit` is false for read-only providers (hermes v12+).
    const canEdit = !isReadOnly;
    // Plan 209: `canDelete` is now true for every non-read-only
    // provider, including the default one. The pre-Plan-209 logic
    // hid the delete button on the active card because deleting
    // it would leave the user without an active provider. But
    // that prevented the user from ever getting out of a bad
    // state (e.g. a corrupted active provider that keeps
    // failing). The delete handler in ProviderList now shows a
    // confirmation dialog for the active case that explicitly
    // warns the user and clears the active reference on
    // success.
    const canDelete = !isReadOnly;
    const canDuplicate = !isReadOnly;
    const canTest = !isReadOnly;
    // Phase 4 plans: usage script editor, terminal, default model.
    const canConfigureUsage = false;
    const canOpenTerminal = false;
    const canSetAsDefault = false;

    return {
      isCurrent,
      isActive,
      isDefault,
      isInConfig,
      isFailoverMode,
      isProxyTakeover,
      isOfficialBlockedByProxy,
      isOmo,
      isReadOnly,
      isDefaultModel,
      canEdit,
      canDelete,
      canDuplicate,
      canTest,
      canConfigureUsage,
      canOpenTerminal,
      canSetAsDefault,
    };
  }, [provider, context.defaultProviderId, context.proxyTakeover]);
}
