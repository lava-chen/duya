/**
 * outbound.ts — a durable delivery obligation, never a fire-and-forget send.
 *
 * ## Establish, then send
 *
 * A delivery row exists before the network call, so a crash between the two
 * leaves evidence of an obligation instead of a silence. The row is idempotent
 * on `projectId + requestId`: a retried tool call returns the FIRST delivery and
 * its real status, which may still be `queued` — a queue entry is not a receipt.
 *
 * ## Re-authorize at the moment of sending
 *
 * The checks that matter can change while the row waits: the binding revoked,
 * the connection disabled, the token rotated. So the send path re-reads the
 * binding AND the connection AFTER claiming the row, and refuses to send with a
 * stale generation. A revoked binding does not get "one last message" out.
 *
 * ## `unknown` is a real answer
 *
 * A timeout, a dropped socket, or a crash after claiming is not evidence that
 * the message did not arrive. It is recorded as `unknown` and nothing resends
 * it: a guessed retry can duplicate a message a human already read. Only a
 * classified "definitely not delivered" (rate limit inside a bounded budget)
 * is retried, once.
 */

import type {
  ProjectChannelBinding,
  ProjectChannelDelivery,
  ProjectChannelSendMessageInput,
  ProjectChannelSendResult,
  ProjectChannelTransportSendInput,
} from '@duya/agent-protocol/project-channels';
import {
  PROJECT_CHANNEL_UNKNOWN_CODES,
  deliveryBodyFingerprint,
  type ProjectChannelErrorCode,
} from '@duya/agent-protocol/project-channels';
import { errorCodeOf, projectChannelServiceError, type ProjectChannelContext } from './types.js';

/** The caller facts the tool layer already validated; none is model-supplied. */
export interface ProjectChannelCaller {
  readonly projectId: string;
  readonly sessionId: string;
  readonly runId: string | null;
  readonly epoch: number | null;
}

export interface ProjectChannelOutbound {
  send(caller: ProjectChannelCaller, request: ProjectChannelSendMessageInput): Promise<ProjectChannelSendResult>;
  /** Settle deliveries an interrupted process left mid-send. Never resends. */
  reclaimInterrupted(deliveryIds: readonly string[]): number;
}

/** The longest rate-limit wait a single request will absorb inline. */
const MAX_INLINE_RETRY_WAIT_MS = 2_000;

export function createProjectChannelOutbound(context: ProjectChannelContext): ProjectChannelOutbound {
  const { stores, clock } = context;

  function bindingFor(caller: ProjectChannelCaller, bindingId: string): ProjectChannelBinding {
    const binding = stores.channels.getBinding(bindingId);
    if (binding === null || binding.projectId !== caller.projectId) {
      // A binding of another Project is indistinguishable from a missing one on
      // purpose: the caller may not probe other Projects' channel ids.
      throw projectChannelServiceError('binding_not_found', 'channel binding does not belong to this project');
    }
    if (!binding.enabled) throw projectChannelServiceError('binding_revoked', 'channel binding has been revoked');
    return binding;
  }

  /**
   * A reply must reference a real inbound of this Project, this binding, and
   * THIS Run — the run that was actually started for that inbound.
   *
   * Checking only the target Session is not enough: a later local turn of the
   * same Coordinator would then be able to quote any earlier channel message
   * and treat it as its own reply scope, which is exactly how `allowProactive`
   * gets bypassed. The grant is therefore read from the durable input receipt
   * of this Session, which records the run id that admission started, and it is
   * fenced again by the Host's live attempt check so a settled run or a
   * superseded epoch cannot send. The tool layer cannot supply any of these
   * facts; they are all derived from rows.
   */
  async function replyTarget(
    caller: ProjectChannelCaller,
    binding: ProjectChannelBinding,
    inboundId: string,
  ): Promise<string> {
    if (caller.runId === null || caller.epoch === null) {
      throw projectChannelServiceError('reply_scope_invalid', 'a reply requires a live run, not a client session');
    }
    const inbound = stores.channels.getInbound(inboundId);
    if (inbound === null
      || inbound.connectionId !== binding.connectionId
      || inbound.bindingId !== binding.bindingId
      || inbound.targetSessionId !== caller.sessionId) {
      throw projectChannelServiceError('reply_scope_invalid', 'reply target is not an inbound of this binding and session');
    }
    requireCurrentCoordinator(caller, 'reply_scope_invalid');
    const receipt = stores.sessionInputs.get(caller.sessionId, inbound.inboundId);
    if (receipt === null
      || (receipt.stage !== 'delivered' && receipt.stage !== 'consumed')
      || receipt.runId !== caller.runId) {
      // The inbound was never admitted to a run, or it was admitted to a
      // different one. Either way this caller holds no reply scope for it.
      throw projectChannelServiceError('reply_scope_invalid', 'this run was not granted this inbound');
    }
    if (!(await context.execution.isCurrentAttempt(caller.sessionId, caller.runId, caller.epoch))) {
      throw projectChannelServiceError('reply_scope_invalid', 'the run that received this inbound is no longer current');
    }
    return inbound.platformMessageId;
  }

  /** The caller must be the Project's current Coordinator, not merely its Session id owner. */
  function requireCurrentCoordinator(caller: ProjectChannelCaller, code: ProjectChannelErrorCode): void {
    const project = stores.projects.get(caller.projectId);
    if (project === null || project.coordinator_session_id !== caller.sessionId) {
      throw projectChannelServiceError(code, 'only the current Coordinator of this project may speak for it');
    }
  }

  async function requireProactive(caller: ProjectChannelCaller, binding: ProjectChannelBinding): Promise<void> {
    if (!binding.allowProactive) {
      throw projectChannelServiceError('proactive_not_allowed', 'this binding does not allow unsolicited sends');
    }
    // Proactive sends speak for the Project, so only its current Coordinator
    // may ask, and only from a run that is still live. A work Session that
    // happens to hold the binding id may not, and neither may a Coordinator
    // turn that already settled.
    requireCurrentCoordinator(caller, 'proactive_not_allowed');
    if (caller.runId === null || caller.epoch === null) {
      throw projectChannelServiceError('proactive_not_allowed', 'proactive sends require a live run');
    }
    if (!(await context.execution.isCurrentAttempt(caller.sessionId, caller.runId, caller.epoch))) {
      throw projectChannelServiceError('proactive_not_allowed', 'the calling run is no longer current');
    }
  }

  async function claimAndSend(
    delivery: ProjectChannelDelivery,
    text: string,
    replyToPlatformMessageId: string | undefined,
  ): Promise<ProjectChannelSendResult> {
    const claimed = stores.channels.claimDelivery(delivery.deliveryId, clock.now());
    if (claimed === null) {
      // Another caller owns this delivery, or it already settled. Report the
      // stored truth instead of inventing a second attempt.
      const current = stores.channels.getDelivery(delivery.deliveryId);
      return { deliveryId: delivery.deliveryId, status: current?.status ?? 'unknown' };
    }

    // Re-read after claiming: the checks below must describe the world the send
    // actually happens in, not the world when the obligation was created.
    const liveBinding = stores.channels.getBinding(claimed.bindingId);
    const liveConnection = stores.channels.getActiveConnection(claimed.connectionId);
    if (liveBinding === null || !liveBinding.enabled) {
      stores.channels.settleDelivery({
        deliveryId: claimed.deliveryId, status: 'cancelled', reason: 'binding_revoked', now: clock.now(),
      });
      return { deliveryId: claimed.deliveryId, status: 'cancelled' };
    }
    if (liveConnection === null) {
      stores.channels.settleDelivery({
        deliveryId: claimed.deliveryId, status: 'cancelled', reason: 'connection_disabled', now: clock.now(),
      });
      return { deliveryId: claimed.deliveryId, status: 'cancelled' };
    }

    const input: ProjectChannelTransportSendInput = {
      deliveryId: claimed.deliveryId,
      connectionId: liveConnection.connectionId,
      generation: liveConnection.generation,
      guildId: liveBinding.guildId,
      channelId: liveBinding.channelId,
      text,
      ...(replyToPlatformMessageId === undefined ? {} : { replyToPlatformMessageId }),
    };

    let outcome: Awaited<ReturnType<ProjectChannelContext['transport']['send']>>;
    try {
      outcome = await context.transport.send(input);
    } catch (error) {
      const code = errorCodeOf(error, 'delivery_unknown');
      const settled = stores.channels.settleDelivery({
        deliveryId: claimed.deliveryId,
        status: isUnknown(code) ? 'unknown' : 'failed',
        reason: code,
        now: clock.now(),
      });
      return { deliveryId: claimed.deliveryId, status: settled?.status ?? 'unknown' };
    }

    if ('platformMessageId' in outcome) {
      const settled = stores.channels.settleDelivery({
        deliveryId: claimed.deliveryId,
        status: 'sent',
        platformMessageId: outcome.platformMessageId,
        now: clock.now(),
      });
      return { deliveryId: claimed.deliveryId, status: settled?.status ?? 'sent' };
    }

    // A classified failure. A bounded rate-limit wait is the only thing retried
    // here: the adapter already told us the message was NOT delivered.
    if (outcome.code === 'delivery_retryable'
      && typeof outcome.retryAfterMs === 'number'
      && outcome.retryAfterMs <= MAX_INLINE_RETRY_WAIT_MS) {
      await clock.sleep(outcome.retryAfterMs);
      return sendOnce(claimed.deliveryId, input);
    }

    const code: ProjectChannelErrorCode = outcome.code;
    const settled = stores.channels.settleDelivery({
      deliveryId: claimed.deliveryId,
      status: isUnknown(code) ? 'unknown' : 'failed',
      reason: reasonWithRetry(code, outcome.retryAfterMs),
      now: clock.now(),
    });
    return { deliveryId: claimed.deliveryId, status: settled?.status ?? 'failed' };
  }

  /** One more attempt for a request the platform explicitly did not deliver. */
  async function sendOnce(
    deliveryId: string,
    input: ProjectChannelTransportSendInput,
  ): Promise<ProjectChannelSendResult> {
    try {
      const retried = await context.transport.send(input);
      if ('platformMessageId' in retried) {
        const settled = stores.channels.settleDelivery({
          deliveryId, status: 'sent', platformMessageId: retried.platformMessageId, now: clock.now(),
        });
        return { deliveryId, status: settled?.status ?? 'sent' };
      }
      const code: ProjectChannelErrorCode = retried.code;
      const settled = stores.channels.settleDelivery({
        deliveryId,
        status: isUnknown(code) ? 'unknown' : 'failed',
        reason: reasonWithRetry(code, retried.retryAfterMs),
        now: clock.now(),
      });
      return { deliveryId, status: settled?.status ?? 'failed' };
    } catch (error) {
      const code = errorCodeOf(error, 'delivery_unknown');
      const settled = stores.channels.settleDelivery({
        deliveryId,
        status: isUnknown(code) ? 'unknown' : 'failed',
        reason: code,
        now: clock.now(),
      });
      return { deliveryId, status: settled?.status ?? 'unknown' };
    }
  }

  return {
    async send(caller, request) {
      if (request.text.trim() === '') {
        throw projectChannelServiceError('invalid_request', 'text must not be empty');
      }
      if (request.text.length > context.maxTextLength) {
        // Refused before a delivery exists: a silently truncated channel message
        // is a message the reader was never told about.
        throw projectChannelServiceError('invalid_request', 'text exceeds the platform limit');
      }
      const binding = bindingFor(caller, request.channelBindingId);
      const connection = stores.channels.getActiveConnection(binding.connectionId);
      if (connection === null) {
        throw projectChannelServiceError('connection_disabled', 'connection is disabled');
      }
      if (!connection.credentialConfigured) {
        throw projectChannelServiceError('credential_not_configured', 'connection has no credential');
      }

      const replyToInboundId = request.replyToInboundId?.trim() ?? '';
      const replyToPlatformMessageId = replyToInboundId === ''
        ? undefined
        : await replyTarget(caller, binding, replyToInboundId);
      if (replyToPlatformMessageId === undefined) await requireProactive(caller, binding);

      const fingerprint = deliveryBodyFingerprint({
        bindingId: binding.bindingId,
        text: request.text,
        replyToInboundId: replyToInboundId === '' ? null : replyToInboundId,
      });
      const created = stores.channels.createDelivery({
        deliveryId: clock.newId(),
        projectId: caller.projectId,
        bindingId: binding.bindingId,
        bindingRevision: binding.revision,
        connectionId: connection.connectionId,
        connectionRevision: connection.revision,
        sessionId: caller.sessionId,
        runId: caller.runId,
        epoch: caller.epoch,
        requestId: request.requestId,
        body: {
          bindingId: binding.bindingId,
          text: request.text,
          replyToInboundId: replyToInboundId === '' ? null : replyToInboundId,
        },
        replyToInboundId: replyToInboundId === '' ? null : replyToInboundId,
        now: clock.now(),
      });
      const delivery = created.record;
      if (delivery.bodyFingerprint !== fingerprint) {
        // The store compares digests; this is a defensive check that the body we
        // are about to send is the body the ruling above authorized.
        throw projectChannelServiceError('delivery_conflict', 'delivery body does not match its record');
      }
      if (created.deduplicated) {
        // A retried request id returns the original delivery and its real state.
        // `queued`/`sending` means someone else still owns the send.
        return { deliveryId: delivery.deliveryId, status: delivery.status };
      }
      if (delivery.status !== 'queued') {
        return { deliveryId: delivery.deliveryId, status: delivery.status };
      }
      return claimAndSend(delivery, request.text, replyToPlatformMessageId);
    },

    reclaimInterrupted(deliveryIds) {
      let settled = 0;
      for (const deliveryId of deliveryIds) {
        const delivery = stores.channels.getDelivery(deliveryId);
        if (delivery === null || delivery.status !== 'sending') continue;
        const record = stores.channels.settleDelivery({
          deliveryId,
          status: 'unknown',
          reason: 'interrupted_while_sending',
          now: clock.now(),
        });
        if (record !== null) settled += 1;
      }
      return settled;
    },
  };
}

function isUnknown(code: ProjectChannelErrorCode): boolean {
  // `transport_unavailable` also means "no receipt": the adapter never got a
  // platform answer, so treating it as a definite failure would invite a resend
  // that might duplicate a delivered message.
  return PROJECT_CHANNEL_UNKNOWN_CODES.has(code) || code === 'transport_unavailable';
}

/**
 * Keep the adapter's Retry-After hint inside the recorded reason. The status
 * column stays the closed set; operators still see why a retryable failure was
 * not retried here.
 */
function reasonWithRetry(code: ProjectChannelErrorCode, retryAfterMs: number | undefined): string {
  return retryAfterMs === undefined ? code : `${code};retry_after_ms=${retryAfterMs}`;
}
