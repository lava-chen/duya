/**
 * electron/wake/channels.ts — ChannelBackgroundWakes (plan 488 §3.5)
 *
 * Bridges the channel store to the WakeBus (plan 476).
 *
 * ## Architecture
 *
 * Inbound flow:
 *   channel message → wakeForInbound(agentId, envelope)
 *     → enqueueInboundWake(sessionId, { envelopeId, text })   [via wake-dispatcher]
 *     → notifySessionIdle(sessionId)                             [kick drain]
 *     → dispatcher drain → runWake(sessionId, prompt)
 *     → runWakePromptInExistingSession(sessionId, prompt)
 *       → buildChannelInboundWakePrompt(envelopes)             [via prompts.ts]
 *       → POST /sessions/:id/chat (hidden wake run)
 *
 * Delivery failure flow:
 *   deliverToChannel fails → queueChannelDeliveryFailure()
 *     → reviveForChannelFailures(agentId)
 *     → buildChannelDeliveryFailureWakePrompt(failures)
 *     → enqueueInboundWake(sessionId, { envelopeId: "failure:<id>", text })
 *     → same drain path as inbound
 *
 * Outbound flow (P1.2 stub — full impl in Phase 2):
 *   deliverToChannel() → channelDelivery(agentId, addr, msg)
 *     → logs "stub" until connector transport is wired (Phase 2 P2.2)
 *
 * ## Session ↔ Agent resolution
 *
 * Currently the WakeBus (476) is session-scoped. The channel system is
 * agent-scoped. The mapping "which session corresponds to this agent" is
 * resolved by the gateway wiring (Phase 1 P1.3). For P1.2 we assume the
 * caller has already resolved agentId → sessionId before calling these methods.
 */

import { enqueueInboundWake, notifySessionIdle } from './wake-dispatcher';
import { runWakePromptInExistingSession } from './wake-run';
import { parseChannelAddress } from '../../packages/agent/src/channels/types';
import type { ChannelAddress, ChannelInboundEnvelope, ChannelOutboundMessage, DeliveryFailure } from '../../packages/agent/src/channels/types';
import { buildChannelInboundWakePrompt, buildChannelDeliveryFailureWakePrompt, CHANNEL_INBOUND_WAKE_CUE, CHANNEL_DELIVERY_FAILED_WAKE_CUE } from '../../packages/agent/src/channels/prompts';
import { getCoreStores } from '../db/core-connection';
import { getLogger, LogComponent } from '../logging/logger';
import { openChannelStore } from '../channels/channel-store';
import { getConnectorSecretStore } from '../channels/connector-secret-store';

// =============================================================================
// Inbound envelope store
// =============================================================================

/**
 * In-memory storage for inbound envelopes, keyed by sessionId.
 * Used by reviveForInbound to reconstruct the prompt.
 *
 * Durability: every envelope is also appended to the session's durable
 * `connector.inbound` pending-wake row (persistInboundEnvelope) and the row
 * is cleared when the wake item is consumed, so a restart re-seeds this
 * store from wake-rearm instead of silently dropping the messages.
 */
export const inboundEnvelopeStore = new Map<string, ChannelInboundEnvelope[]>();

// =============================================================================
// Durable envelope persistence (grok-gap: the store above is memory-only, so
// a restart dropped undelivered channel messages even though the durable
// connector.inbound wake marker survived — the marker now carries the
// envelopes themselves, per session).
// =============================================================================

/** Pending-wake row workId for connector.inbound — one row per session. */
const INBOUND_WAKE_KIND = 'connector.inbound' as const;

/**
 * Append an inbound envelope to the session's durable pending-wake row so a
 * restart can restore it into {@link inboundEnvelopeStore} (see wake-rearm).
 * Best-effort: failures log and keep the in-memory path authoritative.
 */
function persistInboundEnvelope(sessionId: string, envelope: ChannelInboundEnvelope): void {
  try {
    const { wakes } = getCoreStores();
    const envelopes = loadPersistedInboundEnvelopes(wakes.get(INBOUND_WAKE_KIND, sessionId));
    envelopes.push(envelope);
    wakes.persist({
      kind: INBOUND_WAKE_KIND,
      workId: sessionId,
      agentId: sessionId,
      lane: 'background',
      title: envelope.text.slice(0, 200),
      quietOriginJson: JSON.stringify({ envelopes }),
    });
  } catch (err) {
    logger.warn('wakeForInbound: durable envelope persist failed', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    }, LogComponent.Automation);
  }
}

/** Parse the envelope list out of a connector.inbound row (defensively). */
export function loadPersistedInboundEnvelopes(
  row: { quietOriginJson?: string | null; quiet_origin_json?: string | null } | null | undefined,
): ChannelInboundEnvelope[] {
  const raw = row ? (row.quietOriginJson ?? row.quiet_origin_json ?? null) : null;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { envelopes?: unknown };
    return Array.isArray(parsed?.envelopes) ? (parsed.envelopes as ChannelInboundEnvelope[]) : [];
  } catch {
    return [];
  }
}

/**
 * Re-seed the in-memory envelope store from the durable row (restart rearm).
 * Appends so envelopes that arrived between the persist and the rearm are
 * never lost.
 */
export function restoreInboundEnvelopes(sessionId: string, envelopes: ChannelInboundEnvelope[]): void {
  const existing = inboundEnvelopeStore.get(sessionId) ?? [];
  inboundEnvelopeStore.set(sessionId, [...existing, ...envelopes]);
}

// =============================================================================
// Delivery failure queue
// =============================================================================

/**
 * In-memory queue of delivery failures, keyed by sessionId.
 * Persisted across revives via the envelopeId pattern (failure:<id>).
 *
 * Real persistence (pending_wakes) is wired in Phase 1 P1.3.
 */
const deliveryFailureQueues = new Map<string, DeliveryFailure[]>();

const logger = getLogger();

// =============================================================================
// ChannelBackgroundWakes
// =============================================================================



// =============================================================================
// Module-level wakeForInbound (for gateway wiring — plan 488 P1.3)
// =============================================================================

/**
 * Enqueue a channel inbound wake (module-level, for gateway use).
 *
 * This is the gateway-side entry point for the channel wake pipeline:
 *   gateway:inbound → wakeForInbound(sessionId, envelope)
 *     → stores envelope in inboundEnvelopeStore
 *     → calls enqueueInboundWake(sessionId, { envelopeId, text })
 *     → calls notifySessionIdle(sessionId) to kick the dispatcher
 *
 * The dispatcher drain then calls reviveForInbound which reads from
 * inboundEnvelopeStore and calls runWakePromptInExistingSession.
 *
 * In duya, channels are session-scoped (bound via channel_bindings table),
 * so we use sessionId as the agentId for channel store path resolution.
 */
export function wakeForInbound(
  sessionId: string,
  envelope: ChannelInboundEnvelope,
): void {
  const agentId = sessionId; // duya channels are session-scoped

  // In duya, channels are session-scoped (bound via channel_bindings table).
  // We don't validate against the channel store here — the binding is established
  // at the gateway level via getSessionId(). The channel store is used for
  // per-session channel config (label, credentials), not for routing decisions.

  // Store envelope for later revive
  if (!inboundEnvelopeStore.has(sessionId)) {
    inboundEnvelopeStore.set(sessionId, []);
  }
  inboundEnvelopeStore.get(sessionId)!.push(envelope);

  // Durably record the envelope so a restart can re-wake with the full
  // payload (the in-memory store above dies with the process).
  persistInboundEnvelope(sessionId, envelope);

  // Enqueue the connector.inbound wake
  const envelopeId = `${agentId}:${envelope.address.platform}:${envelope.address.chat}`;
  const result = enqueueInboundWake(sessionId, {
    envelopeId,
    text: envelope.text,
  });

  // Kick the dispatcher (dynamic import to avoid circular dependency with wake-dispatcher)
  void import('./wake-dispatcher').then(({ notifySessionIdle: notify }) => notify(sessionId));

  logger.info('wakeForInbound: enqueued connector.inbound wake', {
    sessionId,
    agentId,
    result,
    platform: envelope.address.platform,
  }, LogComponent.AgentProcess);
}

export interface ChannelBackgroundWakes {
  /**
   * Enqueue a channel inbound message as a background wake.
   * Called by the gateway when a channel message arrives.
   *
   * @param sessionId  - The session to wake (resolved by gateway wiring, P1.3)
   * @param agentId    - The agent that owns the channel
   * @param envelope   - The inbound channel message
   */
  wakeForInbound(sessionId: string, agentId: string, envelope: ChannelInboundEnvelope): void;

  /**
   * Revive a queued inbound wake — called when the session becomes idle and
   * the dispatcher is draining background wakes. This builds the actual prompt
   * from the stored envelopes and runs it.
   *
   * In the full implementation this is called by the dispatcher drain when it
   * encounters a `connector.inbound` wake item. The dispatcher passes the
   * sessionId; we look up the stored envelopes per agent.
   *
   * @param sessionId - The session to run the wake in
   */
  reviveForInbound(sessionId: string): Promise<void>;

  /**
   * Deliver an outbound channel message via the connector transport.
   * This is the outgoing half of the channel system.
   *
   * Phase 1 P1.2: stub — logs a warning and returns.
   * Phase 2 P2.2: wires to the actual connector transport.
   *
   * @param agentId     - The agent sending the message
   * @param addressToken - Channel address as a string token, e.g. "slack:C12345"
   * @param outbound    - The message to send
   */
  deliverToChannel(
    agentId: string,
    sessionId: string,
    addressToken: string,
    outbound: ChannelOutboundMessage,
  ): Promise<void>;

  /**
   * Revive queued delivery failures as inbound wakes.
   * Called when the session becomes idle and there are pending failures.
   *
   * @param sessionId - The session to wake
   * @param agentId   - The agent that owns the channel
   */
  reviveForChannelFailures(sessionId: string, agentId: string): Promise<void>;
}

// =============================================================================
// Implementation
// =============================================================================

export class DefaultChannelBackgroundWakes implements ChannelBackgroundWakes {
  wakeForInbound(
    sessionId: string,
    agentId: string,
    envelope: ChannelInboundEnvelope,
  ): void {
    // Validate agent has this channel configured
    const store = openChannelStore(agentId);
    const platforms = store.listPlatforms();
    if (!platforms.includes(envelope.address.platform)) {
      logger.warn('ChannelBackgroundWakes: inbound for unconfigured platform', {
        sessionId,
        agentId,
        platform: envelope.address.platform,
      }, LogComponent.AgentProcess);
      return;
    }

    // Store envelope for later revive
    const key = sessionId;
    if (!inboundEnvelopeStore.has(key)) {
      inboundEnvelopeStore.set(key, []);
    }
    inboundEnvelopeStore.get(key)!.push(envelope);

    // Durably record the envelope (same contract as the module-level path).
    persistInboundEnvelope(sessionId, envelope);

    // Enqueue the inbound wake with the dispatcher
    const result = enqueueInboundWake(sessionId, {
      envelopeId: `${agentId}:${envelope.address.platform}:${envelope.address.chat}`,
      text: envelope.text,
    });

    logger.info('ChannelBackgroundWakes: enqueued inbound wake', {
      sessionId,
      agentId,
      result,
      platform: envelope.address.platform,
    }, LogComponent.AgentProcess);

    // Kick the drain if the session is currently idle
    notifySessionIdle(sessionId);
  }

  async reviveForInbound(sessionId: string): Promise<void> {
    // Delegate to the module-level function (used by wake-dispatcher.ts integration)
    return reviveForInbound(sessionId);
  }

  async deliverToChannel(
    agentId: string,
    sessionId: string,
    addressToken: string,
    outbound: ChannelOutboundMessage,
  ): Promise<void> {
    // Dynamically import channelDelivery to avoid circular dependency with electron main
    const { channelDelivery } = await import('../channels/channel-delivery');

    logger.info('ChannelBackgroundWakes: deliverToChannel called', {
      agentId,
      sessionId,
      addressToken,
      outboundKind: outbound.kind,
    }, LogComponent.AgentProcess);

    try {
      await channelDelivery(agentId, addressToken, outbound);

      logger.info('ChannelBackgroundWakes: deliverToChannel succeeded', {
        agentId,
        sessionId,
        addressToken,
      }, LogComponent.AgentProcess);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const address = parseChannelAddress(addressToken);

      logger.error(
        'ChannelBackgroundWakes: deliverToChannel failed',
        new Error(reason),
        { agentId, sessionId, addressToken },
        LogComponent.AgentProcess,
      );

      // Queue the failure for later `[channel-delivery-failed]` wake.
      // channelDelivery validates the token and throws on malformed input,
      // but defensively guard against the address still being null here —
      // otherwise the failure record gets lost (and the original delivery
      // error masks as a TypeError) when the IPC caller passes a token that
      // a future channelDelivery relaxation accepts but parseChannelAddress
      // does not.
      const failure: DeliveryFailure | null = address
        ? {
            sessionId,
            address,
            outbound,
            reason,
            failedAt: Date.now(),
          }
        : null;
      if (failure) queueChannelDeliveryFailure(failure);

      // Fire the failure wake without awaiting it: the wake runs its own turn
      // (it acquires the session lock internally), and blocking here would
      // hold the `channel:deliver` IPC past the agent's db-client timeout —
      // observed as a 30s "DB request timeout" tool result masking the real
      // delivery reason.
      void reviveForChannelFailuresWake(sessionId).catch((wakeErr) => {
        logger.warn('ChannelBackgroundWakes: failure wake revival failed', {
          sessionId,
          error: wakeErr instanceof Error ? wakeErr.message : String(wakeErr),
        }, LogComponent.AgentProcess);
      });

      // Re-throw so the IPC caller surfaces the real delivery reason back to
      // the SendMessage tool instead of reporting a false success.
      throw err instanceof Error ? err : new Error(reason);
    }
  }

  async reviveForChannelFailures(sessionId: string, agentId: string): Promise<void> {
    // agentId not needed at this layer (kept for interface symmetry)
    return reviveForChannelFailuresWake(sessionId);
  }
}

// =============================================================================
// Module-level revive functions (exported for wake-dispatcher.ts integration)
// =============================================================================

/**
 * Revive a queued connector.inbound wake by building the rich channel prompt
 * from stored envelopes and running it via runWakePromptInExistingSession.
 *
 * This is the executor that wake-dispatcher.ts calls (Plan B, 488 §1.4) when
 * it drains a connector.inbound background wake item. The dispatcher drain
 * detects connector.inbound by `item.source === 'connector.inbound'` and calls
 * this function instead of the generic buildPrompt path.
 *
 * Does NOT hold the session lock — runWakePromptInExistingSession acquires it
 * internally, so this is safe to call without deadlock risk.
 */
export async function reviveForInbound(sessionId: string): Promise<void> {
  const envelopes = inboundEnvelopeStore.get(sessionId) ?? [];
  if (!envelopes.length) return;

  const prompt = buildChannelInboundWakePrompt(envelopes);

  // Clear stored envelopes AFTER building the prompt (clearing before would lose
  // the data if runWakePromptInExistingSession throws — in that case the
  // envelopes remain in the store for a potential retry path)
  // NOTE: envelopes are only cleared after successful run completion.
  if (!prompt) {
    // Empty prompt: nothing to wake with, but keep envelopes in case
    // more arrive before the next drain
    return;
  }

  logger.info('ChannelBackgroundWakes: reviving inbound wake', {
    sessionId,
    envelopeCount: envelopes.length,
  }, LogComponent.AgentProcess);

  try {
    await runWakePromptInExistingSession(sessionId, prompt);
    // Only clear after successful completion
    inboundEnvelopeStore.delete(sessionId);
  } catch (err) {
    logger.warn('ChannelBackgroundWakes: reviveForInbound failed — envelopes NOT cleared', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    }, LogComponent.AgentProcess);
    // Do NOT clear envelopes on failure — they remain for the next revive
    throw err;
  }
}

/**
 * Revive queued channel delivery failures as an inbound wake.
 * Called by channelDelivery failure path.
 */
export async function reviveForChannelFailuresWake(sessionId: string): Promise<void> {
  const failures = deliveryFailureQueues.get(sessionId) ?? [];
  if (!failures.length) return;

  const prompt = buildChannelDeliveryFailureWakePrompt(failures);
  deliveryFailureQueues.delete(sessionId);

  if (!prompt) return;

  logger.info('ChannelBackgroundWakes: reviving channel delivery failures', {
    sessionId,
    failureCount: failures.length,
  }, LogComponent.AgentProcess);

  await runWakePromptInExistingSession(sessionId, prompt);
}

// =============================================================================
// Module-level singleton
// =============================================================================

let _instance: ChannelBackgroundWakes | null = null;

export function getChannelBackgroundWakes(): ChannelBackgroundWakes {
  if (!_instance) {
    _instance = new DefaultChannelBackgroundWakes();
  }
  return _instance;
}

// =============================================================================
// Internal helpers (used by gateway wiring in Phase 1 P1.3)
// =============================================================================

/**
 * Queue a delivery failure for later `[channel-delivery-failed]` wake.
 * Called by channelDelivery when the connector transport fails.
 */
export function queueChannelDeliveryFailure(failure: DeliveryFailure): void {
  const key = failure.sessionId;
  if (!deliveryFailureQueues.has(key)) {
    deliveryFailureQueues.set(key, []);
  }
  deliveryFailureQueues.get(key)!.push(failure);
}
