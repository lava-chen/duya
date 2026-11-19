/**
 * project-channels-service.test.ts — the Host channel domain against real SQLite.
 *
 * Covers the plan's slice-C matrix: verified configuration, non-empty
 * allowlists, trusted inbound authorization, persistent queuing instead of
 * steering, revoked authorization, and a send path that distinguishes a queue
 * entry from a platform receipt.
 */

import { describe, expect, it } from 'vitest';
import { inboundDedupKey } from '@duya/agent-protocol/project-channels';
import {
  BOT_USER_ID,
  CHANNEL_ID,
  CONNECTION_TOKEN,
  GUILD_ID,
  MEMBER_ID,
  PROJECT_ID,
  inboundCallback,
  projectChannelsFixture,
} from './project-channels-fixture.js';
import { ProjectChannelServiceError } from '../src/project-channels/index.js';

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ProjectChannelServiceError) return error.code;
    if (error !== null && typeof error === 'object' && 'code' in error) return String(error.code);
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('connection configuration', () => {
  it('verifies the Bot with the platform before storing anything', async () => {
    const fixture = projectChannelsFixture();
    const code = await codeOf(() => fixture.service.configureDiscordConnection({
      projectId: PROJECT_ID, requestId: 'cfg-bad', token: 'not-a-token',
    }));
    expect(code).toBe('credential_invalid');
    expect(fixture.channels.listConnections()).toHaveLength(0);
    expect(await fixture.secrets.read('any')).toBeNull();
    expect(fixture.transport.starts).toHaveLength(0);
  });

  it('records the platform-verified Bot, starts the transport, and never exposes the token', async () => {
    const fixture = projectChannelsFixture();
    const connection = await fixture.service.configureDiscordConnection({
      projectId: PROJECT_ID, requestId: 'cfg-1', token: CONNECTION_TOKEN, label: 'Alpha Bot',
    });
    expect(connection.botUserId).toBe(BOT_USER_ID);
    expect(connection.credentialConfigured).toBe(true);
    expect(connection.revision).toBe(1);
    expect(JSON.stringify(connection)).not.toContain(CONNECTION_TOKEN);
    expect(fixture.transport.starts).toHaveLength(1);
    expect(fixture.transport.starts[0]!.generation).toBe(connection.generation);
    expect(await fixture.secrets.read(connection.connectionId)).toBe(CONNECTION_TOKEN);

    const overview = await fixture.service.getProjectChannels(PROJECT_ID);
    expect(overview?.connection?.connectionId).toBe(connection.connectionId);
    expect(JSON.stringify(overview)).not.toContain(CONNECTION_TOKEN);
    // The observation is the runtime truth, separate from the stored config.
    expect(overview?.observation?.state).toBe('connected');
  });

  it('refuses a second Project claiming the same Bot identity', async () => {
    const fixture = projectChannelsFixture({ withSecondProject: true });
    await fixture.connected();
    const code = await codeOf(() => fixture.service.configureDiscordConnection({
      projectId: 'project-b', requestId: 'cfg-b', token: CONNECTION_TOKEN,
    }));
    expect(code).toBe('bot_identity_conflict');
  });

  it('requires the observed revision to change an existing connection', async () => {
    const fixture = projectChannelsFixture();
    const { connection } = await fixture.connected();
    expect(await codeOf(() => fixture.service.configureDiscordConnection({
      projectId: PROJECT_ID, requestId: 'cfg-2', token: CONNECTION_TOKEN,
    }))).toBe('stale_revision');
    const rotated = await fixture.service.configureDiscordConnection({
      projectId: PROJECT_ID, requestId: 'cfg-3', token: CONNECTION_TOKEN,
      expectedRevision: connection.revision,
    });
    expect(rotated.revision).toBe(connection.revision + 1);
    expect(rotated.generation).toBeGreaterThan(connection.generation);
  });
});

describe('binding authorization', () => {
  it('refuses an empty allowlist and a thread target', async () => {
    const fixture = projectChannelsFixture();
    const { connection } = await fixture.connected();
    expect(await codeOf(() => fixture.service.createBinding({
      projectId: PROJECT_ID, requestId: 'b-empty', connectionId: connection.connectionId,
      guildId: GUILD_ID, channelId: CHANNEL_ID, allowedUserIds: [],
    }))).toBe('invalid_allowlist');

    fixture.transport.inspection = { guildId: GUILD_ID, channelId: CHANNEL_ID, isTextChannel: true, isThread: true };
    expect(await codeOf(() => fixture.service.createBinding({
      projectId: PROJECT_ID, requestId: 'b-thread', connectionId: connection.connectionId,
      guildId: GUILD_ID, channelId: CHANNEL_ID, allowedUserIds: [MEMBER_ID],
    }))).toBe('invalid_target');

    // The store sees a channel the platform refused to confirm: a name or id the
    // caller made up must not become a binding.
    fixture.transport.inspection = { guildId: GUILD_ID, channelId: 'real-channel', isTextChannel: true, isThread: false };
    expect(await codeOf(() => fixture.service.createBinding({
      projectId: PROJECT_ID, requestId: 'b-unknown', connectionId: connection.connectionId,
      guildId: GUILD_ID, channelId: 'other', allowedUserIds: [MEMBER_ID],
    }))).toBe('invalid_target');
  });

  it('refuses to bind without a stored credential', async () => {
    const fixture = projectChannelsFixture();
    const { connection } = await fixture.connected();
    await fixture.secrets.remove(connection.connectionId);
    expect(await codeOf(() => fixture.service.createBinding({
      projectId: PROJECT_ID, requestId: 'b-2', connectionId: connection.connectionId,
      guildId: GUILD_ID, channelId: CHANNEL_ID, allowedUserIds: [MEMBER_ID],
    }))).toBe('credential_not_configured');
  });
});

describe('inbound authorization', () => {
  it('accepts a native mention from an allowlisted member and starts one run', async () => {
    const fixture = projectChannelsFixture();
    const { connection } = await fixture.connected();
    const inboundId = await fixture.service.handleInbound(inboundCallback(connection.connectionId, connection.generation));

    expect(fixture.execution.starts).toHaveLength(1);
    const start = fixture.execution.starts[0]!;
    expect(start.sessionId).toBe(fixture.coordinatorId);
    expect(start.inboundId).toBe(inboundId);
    expect(start.prompt).toContain('[project-channel:inbound]');
    expect(start.prompt).toContain('untrusted');
    expect(start.prompt).toContain('what is the status of the login task?');

    const inbound = fixture.channels.getInbound(inboundId);
    expect(inbound?.text).toBe('what is the status of the login task?');
    expect(inbound?.targetSessionId).toBe(fixture.coordinatorId);
    expect(inbound?.dedupKey).toBe(inboundDedupKey(connection.connectionId, 'platform-message-1'));
    const receipt = fixture.sessionInputs.get(fixture.coordinatorId, inboundId);
    expect(receipt?.stage).toBe('delivered');
    expect(receipt?.actorKind).toBe('channel');
  });

  it.each([
    ['other Bot and webhook authors', { authorIsBot: true }, 'unauthorized_member'],
    ['a missing native mention', { mentionIds: [] }, 'invalid_target'],
    ['a member outside the allowlist', { senderId: 'stranger' }, 'unauthorized_member'],
    ['an unbound channel', { channelId: 'other-channel' }, 'binding_not_found'],
    ['empty text', { text: '   ' }, 'invalid_request'],
  ])('refuses %s', async (_label, overrides, expected) => {
    const fixture = projectChannelsFixture();
    const { connection } = await fixture.connected();
    const code = await codeOf(() => fixture.service.handleInbound(
      inboundCallback(connection.connectionId, connection.generation, overrides),
    ));
    expect(code).toBe(expected);
    expect(fixture.execution.starts).toHaveLength(0);
    expect(fixture.channels.getInboundByDedup(connection.connectionId, 'platform-message-1')).toBeNull();
  });

  it('refuses a callback from a replaced generation', async () => {
    const fixture = projectChannelsFixture();
    const { connection } = await fixture.connected();
    const code = await codeOf(() => fixture.service.handleInbound(
      inboundCallback(connection.connectionId, connection.generation - 1),
    ));
    expect(code).toBe('generation_stale');
  });

  it('answers a redelivery with the original inbound and does not start a second run', async () => {
    const fixture = projectChannelsFixture();
    const { connection } = await fixture.connected();
    const first = await fixture.service.handleInbound(inboundCallback(connection.connectionId, connection.generation));
    const second = await fixture.service.handleInbound(inboundCallback(connection.connectionId, connection.generation));
    expect(second).toBe(first);
    expect(fixture.execution.starts).toHaveLength(1);
  });

  it('flags the same message id with a different body as a conflict', async () => {
    const fixture = projectChannelsFixture();
    const { connection } = await fixture.connected();
    await fixture.service.handleInbound(inboundCallback(connection.connectionId, connection.generation, { text: 'first' }));
    const code = await codeOf(() => fixture.service.handleInbound(
      inboundCallback(connection.connectionId, connection.generation, { text: 'second' }),
    ));
    expect(code).toBe('inbound_fingerprint_conflict');
    expect(fixture.channels.getInboundByDedup(connection.connectionId, 'platform-message-1')?.text).toBe('first');
    expect(fixture.execution.starts).toHaveLength(1);
  });

  it('keeps the event for a busy Coordinator and delivers it when the Session settles', async () => {
    const fixture = projectChannelsFixture();
    const { connection } = await fixture.connected();
    fixture.execution.busy.add(fixture.coordinatorId);

    const inboundId = await fixture.service.handleInbound(inboundCallback(connection.connectionId, connection.generation));
    expect(fixture.execution.starts).toHaveLength(0);
    const waiting = fixture.sessionInputs.get(fixture.coordinatorId, inboundId);
    expect(waiting?.stage).toBe('persisted');
    expect(waiting?.reason).toBe('session_busy');
    expect(fixture.channels.getInbound(inboundId)?.text).toContain('login task');

    fixture.execution.busy.delete(fixture.coordinatorId);
    await fixture.service.drainSession(fixture.coordinatorId);
    expect(fixture.execution.starts).toHaveLength(1);
    expect(fixture.sessionInputs.get(fixture.coordinatorId, inboundId)?.stage).toBe('delivered');
  });

  it('respects a local control lease instead of overriding it', async () => {
    const fixture = projectChannelsFixture();
    const { connection } = await fixture.connected();
    // A local client holds the Session; a channel message must wait, not push.
    fixture.leases.acquire({
      sessionId: fixture.coordinatorId, leaseId: 'lease-1', holderKind: 'user', holderId: 'local',
      requestId: 'lease', ttlMs: 60_000, nowMs: 10_000,
    });
    const inboundId = await fixture.service.handleInbound(inboundCallback(connection.connectionId, connection.generation));
    expect(fixture.execution.starts).toHaveLength(0);
    expect(fixture.sessionInputs.get(fixture.coordinatorId, inboundId)?.reason).toBe('control_lease_held');

    // After the lease expires the same durable row is delivered normally.
    fixture.setNow(80_000);
    await fixture.service.drainSession(fixture.coordinatorId);
    expect(fixture.execution.starts).toHaveLength(1);
  });

  it('refuses a queued event whose binding was revoked while it waited', async () => {
    const fixture = projectChannelsFixture();
    const { connection, binding } = await fixture.connected();
    fixture.execution.busy.add(fixture.coordinatorId);
    const inboundId = await fixture.service.handleInbound(inboundCallback(connection.connectionId, connection.generation));

    await fixture.service.revokeBinding({
      projectId: PROJECT_ID, bindingId: binding.bindingId, requestId: 'revoke-1',
      expectedRevision: binding.revision,
    });
    fixture.execution.busy.delete(fixture.coordinatorId);
    await fixture.service.drainSession(fixture.coordinatorId);

    expect(fixture.execution.starts).toHaveLength(0);
    const receipt = fixture.sessionInputs.get(fixture.coordinatorId, inboundId);
    expect(receipt?.stage).toBe('rejected');
    expect(receipt?.reason).toBe('binding_revoked');
  });

  it('does not execute a queued event after the connection is disconnected', async () => {
    const fixture = projectChannelsFixture();
    const { connection } = await fixture.connected();
    fixture.execution.busy.add(fixture.coordinatorId);
    const inboundId = await fixture.service.handleInbound(inboundCallback(connection.connectionId, connection.generation));

    await fixture.service.disconnectConnection({
      projectId: PROJECT_ID, connectionId: connection.connectionId, requestId: 'off-1',
      expectedRevision: connection.revision,
    });
    fixture.execution.busy.delete(fixture.coordinatorId);
    await fixture.service.drainSession(fixture.coordinatorId);

    expect(fixture.execution.starts).toHaveLength(0);
    expect(fixture.sessionInputs.get(fixture.coordinatorId, inboundId)?.reason).toBe('connection_disabled');
    // Disconnect stopped exactly the generation that was running.
    expect(fixture.transport.stops).toEqual([{ connectionId: connection.connectionId, generation: connection.generation }]);
    // Late events from the stopped generation are refused.
    expect(await codeOf(() => fixture.service.handleInbound(
      inboundCallback(connection.connectionId, connection.generation, { platformMessageId: 'late' }),
    ))).toBe('connection_disabled');
  });

  it('records a refused admission as a receipt instead of a silent drop', async () => {
    const fixture = projectChannelsFixture();
    const { connection } = await fixture.connected();
    fixture.execution.refuseWith = 'checkout_conflict';
    const inboundId = await fixture.service.handleInbound(inboundCallback(connection.connectionId, connection.generation, { text: 'hello' }));
    const receipt = fixture.sessionInputs.get(fixture.coordinatorId, inboundId);
    expect(receipt?.stage).toBe('rejected');
    expect(receipt?.reason).toBe('checkout_conflict');
    expect(fixture.channels.getInbound(inboundId)?.text).toBe('hello');
  });
});

describe('outbound send authorization', () => {
  it('replies to a real inbound of this binding and Session', async () => {
    const fixture = projectChannelsFixture();
    const { connection, binding } = await fixture.connected();
    const inboundId = await fixture.service.handleInbound(inboundCallback(connection.connectionId, connection.generation));

    const result = await fixture.service.sendFromCoordinator({
      projectId: PROJECT_ID, sessionId: fixture.coordinatorId, runId: 'run-1', epoch: 0,
    }, {
      requestId: 'send-1', channelBindingId: binding.bindingId, text: 'the login task is in progress',
      replyToInboundId: inboundId,
    });

    expect(result.status).toBe('sent');
    expect(fixture.transport.sends).toHaveLength(1);
    expect(fixture.transport.sends[0]!.replyToPlatformMessageId).toBe('platform-message-1');
    expect(fixture.transport.sends[0]!.generation).toBe(connection.generation);
    const delivery = fixture.channels.getDelivery(result.deliveryId);
    expect(delivery?.platformMessageId).toBe('platform-msg-1');
    expect(delivery?.replyToInboundId).toBe(inboundId);
  });

  it('refuses an unsolicited send unless the binding opted in and the caller is the Coordinator', async () => {
    const fixture = projectChannelsFixture();
    const { binding } = await fixture.connected();
    expect(await codeOf(() => fixture.service.sendFromCoordinator({
      projectId: PROJECT_ID, sessionId: fixture.coordinatorId, runId: 'run-1', epoch: 0,
    }, { requestId: 'send-2', channelBindingId: binding.bindingId, text: 'unsolicited' }))).toBe('proactive_not_allowed');

    const open = projectChannelsFixture({ allowProactive: true });
    const { binding: openBinding } = await open.connected({ allowProactive: true });
    const fromWorkSession = await codeOf(() => open.service.sendFromCoordinator({
      projectId: PROJECT_ID, sessionId: 'work-session-1', runId: 'run-9', epoch: 0,
    }, { requestId: 'send-3', channelBindingId: openBinding.bindingId, text: 'unsolicited' }));
    expect(fromWorkSession).toBe('proactive_not_allowed');

    const allowed = await open.service.sendFromCoordinator({
      projectId: PROJECT_ID, sessionId: open.coordinatorId, runId: 'run-1', epoch: 0,
    }, { requestId: 'send-4', channelBindingId: openBinding.bindingId, text: 'project update' });
    expect(allowed.status).toBe('sent');
  });

  it('refuses to borrow another Session or Project inbound as a reply target', async () => {
    const fixture = projectChannelsFixture({ withSecondProject: true });
    const { connection, binding } = await fixture.connected();
    const inboundId = await fixture.service.handleInbound(inboundCallback(connection.connectionId, connection.generation));

    expect(await codeOf(() => fixture.service.sendFromCoordinator({
      projectId: PROJECT_ID, sessionId: 'work-session-1', runId: 'run-2', epoch: 0,
    }, { requestId: 'send-5', channelBindingId: binding.bindingId, text: 'hi', replyToInboundId: inboundId })))
      .toBe('reply_scope_invalid');

    expect(await codeOf(() => fixture.service.sendFromCoordinator({
      projectId: 'project-b', sessionId: fixture.coordinatorId, runId: 'run-1', epoch: 0,
    }, { requestId: 'send-6', channelBindingId: binding.bindingId, text: 'hi', replyToInboundId: inboundId })))
      .toBe('binding_not_found');
  });

  it('returns the original delivery for a repeated request id and sends once', async () => {
    const fixture = projectChannelsFixture({ allowProactive: true });
    const { binding } = await fixture.connected({ allowProactive: true });
    const first = await fixture.service.sendFromCoordinator({
      projectId: PROJECT_ID, sessionId: fixture.coordinatorId, runId: 'run-1', epoch: 0,
    }, { requestId: 'send-7', channelBindingId: binding.bindingId, text: 'once' });
    const second = await fixture.service.sendFromCoordinator({
      projectId: PROJECT_ID, sessionId: fixture.coordinatorId, runId: 'run-1', epoch: 0,
    }, { requestId: 'send-7', channelBindingId: binding.bindingId, text: 'once' });
    expect(second).toEqual(first);
    expect(fixture.transport.sends).toHaveLength(1);
  });

  it('refuses over-long text before a delivery exists', async () => {
    const fixture = projectChannelsFixture({ allowProactive: true });
    const { binding } = await fixture.connected({ allowProactive: true });
    const code = await codeOf(() => fixture.service.sendFromCoordinator({
      projectId: PROJECT_ID, sessionId: fixture.coordinatorId, runId: 'run-1', epoch: 0,
    }, { requestId: 'send-8', channelBindingId: binding.bindingId, text: 'x'.repeat(2_001) }));
    expect(code).toBe('invalid_request');
    expect(fixture.channels.listDeliveries(PROJECT_ID).deliveries).toHaveLength(0);
    expect(fixture.transport.sends).toHaveLength(0);
  });

  it('retries a bounded rate limit once, and reports a long one without resending', async () => {
    const fixture = projectChannelsFixture({ allowProactive: true });
    const { binding } = await fixture.connected({ allowProactive: true });
    fixture.transport.sendOutcomes = [
      { code: 'delivery_retryable', message: 'rate limited', retryable: true, retryAfterMs: 500 },
      { platformMessageId: 'platform-msg-retry' },
    ];
    const retried = await fixture.service.sendFromCoordinator({
      projectId: PROJECT_ID, sessionId: fixture.coordinatorId, runId: 'run-1', epoch: 0,
    }, { requestId: 'send-9', channelBindingId: binding.bindingId, text: 'retry me' });
    expect(retried.status).toBe('sent');
    expect(fixture.transport.sends).toHaveLength(2);

    fixture.transport.sendOutcomes = [
      { code: 'delivery_retryable', message: 'rate limited', retryable: true, retryAfterMs: 30_000 },
    ];
    const long = await fixture.service.sendFromCoordinator({
      projectId: PROJECT_ID, sessionId: fixture.coordinatorId, runId: 'run-1', epoch: 0,
    }, { requestId: 'send-10', channelBindingId: binding.bindingId, text: 'wait' });
    expect(long.status).toBe('failed');
    expect(fixture.channels.getDelivery(long.deliveryId)?.reason).toContain('retry_after_ms=30000');
    expect(fixture.transport.sends).toHaveLength(3);
  });

  it('records no-evidence failures as unknown and never resends them', async () => {
    const fixture = projectChannelsFixture({ allowProactive: true });
    const { binding } = await fixture.connected({ allowProactive: true });
    fixture.transport.sendOutcomes = [{ code: 'delivery_unknown', message: 'socket closed', retryable: false }];
    const unknown = await fixture.service.sendFromCoordinator({
      projectId: PROJECT_ID, sessionId: fixture.coordinatorId, runId: 'run-1', epoch: 0,
    }, { requestId: 'send-11', channelBindingId: binding.bindingId, text: 'maybe' });
    expect(unknown.status).toBe('unknown');
    expect(fixture.transport.sends).toHaveLength(1);

    fixture.transport.throwOnSend = new Error('ECONNRESET');
    const thrown = await fixture.service.sendFromCoordinator({
      projectId: PROJECT_ID, sessionId: fixture.coordinatorId, runId: 'run-1', epoch: 0,
    }, { requestId: 'send-12', channelBindingId: binding.bindingId, text: 'lost?' });
    expect(thrown.status).toBe('unknown');
    expect(fixture.transport.sends).toHaveLength(2);
  });

  it('refuses to send after the binding is revoked, without a delivery', async () => {
    const fixture = projectChannelsFixture({ allowProactive: true });
    const { binding } = await fixture.connected({ allowProactive: true });
    await fixture.service.revokeBinding({
      projectId: PROJECT_ID, bindingId: binding.bindingId, requestId: 'revoke-2', expectedRevision: binding.revision,
    });
    expect(await codeOf(() => fixture.service.sendFromCoordinator({
      projectId: PROJECT_ID, sessionId: fixture.coordinatorId, runId: 'run-1', epoch: 0,
    }, { requestId: 'send-13', channelBindingId: binding.bindingId, text: 'too late' }))).toBe('binding_revoked');
    expect(fixture.transport.sends).toHaveLength(0);
  });

  it('tracks a real reply obligation for the inbound, and not a failed attempt', async () => {
    const fixture = projectChannelsFixture();
    const { connection, binding } = await fixture.connected();
    const inboundId = await fixture.service.handleInbound(inboundCallback(connection.connectionId, connection.generation));
    expect(fixture.service.hasReplyDelivery(inboundId)).toBe(false);

    fixture.transport.sendOutcomes = [{ code: 'delivery_failed', message: '403', retryable: false }];
    const failed = await fixture.service.sendFromCoordinator({
      projectId: PROJECT_ID, sessionId: fixture.coordinatorId, runId: 'run-1', epoch: 0,
    }, { requestId: 'send-fail', channelBindingId: binding.bindingId, text: 'nope', replyToInboundId: inboundId });
    expect(failed.status).toBe('failed');
    // A failed send is not an answer: the reminder may still fire.
    expect(fixture.service.hasReplyDelivery(inboundId)).toBe(false);

    fixture.transport.sendOutcomes = [{ platformMessageId: 'platform-msg-ok' }];
    await fixture.service.sendFromCoordinator({
      projectId: PROJECT_ID, sessionId: fixture.coordinatorId, runId: 'run-1', epoch: 0,
    }, { requestId: 'send-ok', channelBindingId: binding.bindingId, text: 'here it is', replyToInboundId: inboundId });
    expect(fixture.service.hasReplyDelivery(inboundId)).toBe(true);
  });

  it('reports the stored delivery, not a fresh attempt, for an unknown delivery id', async () => {
    const fixture = projectChannelsFixture({ allowProactive: true });
    const { binding } = await fixture.connected({ allowProactive: true });
    const sent = await fixture.service.sendFromCoordinator({
      projectId: PROJECT_ID, sessionId: fixture.coordinatorId, runId: 'run-1', epoch: 0,
    }, { requestId: 'send-14', channelBindingId: binding.bindingId, text: 'read back' });
    expect(await fixture.service.getDelivery(PROJECT_ID, sent.deliveryId)).not.toBeNull();
    expect(await fixture.service.getDelivery('project-b', sent.deliveryId)).toBeNull();
  });
});

/**
 * The reply scope is a grant to ONE run, not to a Session.
 *
 * These cases exist because checking only `connection + binding + Session`
 * lets a later local turn of the same Coordinator quote an older channel
 * message and pass it off as its own reply, which is the documented way to
 * bypass `allowProactive`. Every case below therefore runs with
 * `strictAttempts` so a fabricated run id cannot be "current".
 */
describe('run-scoped reply authorization', () => {
  /** Configure, receive one message and let the drain start its run. */
  async function deliveredInbound(fixture: ReturnType<typeof projectChannelsFixture>) {
    const { connection, binding } = await fixture.connected({ allowProactive: true });
    const inboundId = await fixture.service.handleInbound(
      inboundCallback(connection.connectionId, connection.generation),
    );
    const attempt = fixture.execution.liveAttempt(fixture.coordinatorId);
    expect(attempt).not.toBeNull();
    return { connection, binding, inboundId, attempt: attempt!, caller: { ...attempt!, projectId: PROJECT_ID } };
  }

  it('accepts the run that actually received the inbound', async () => {
    const fixture = projectChannelsFixture();
    fixture.execution.strictAttempts = true;
    const { binding, inboundId, attempt, caller } = await deliveredInbound(fixture);

    const result = await fixture.service.sendFromCoordinator(caller, {
      requestId: 'scope-ok', channelBindingId: binding.bindingId, text: 'status is green',
      replyToInboundId: inboundId,
    });

    expect(result.status).toBe('sent');
    expect(fixture.channels.getDelivery(result.deliveryId)?.runId).toBe(attempt.runId);
  });

  it('refuses a later run of the same Session borrowing an older inbound', async () => {
    const fixture = projectChannelsFixture();
    fixture.execution.strictAttempts = true;
    const { connection, binding, inboundId } = await deliveredInbound(fixture);

    // A second channel message starts a second run on the same Coordinator.
    const secondInbound = await fixture.service.handleInbound(
      inboundCallback(connection.connectionId, connection.generation, { platformMessageId: 'platform-message-2' }),
    );
    const secondRun = fixture.execution.liveAttempt(fixture.coordinatorId)!;
    const secondCaller = { ...secondRun, projectId: PROJECT_ID };
    expect(secondRun.runId).not.toBe(inboundId);

    // The new run quotes the FIRST message: it never carried that reply scope.
    expect(await codeOf(() => fixture.service.sendFromCoordinator(secondCaller, {
      requestId: 'scope-borrow', channelBindingId: binding.bindingId, text: 'borrowed',
      replyToInboundId: inboundId,
    }))).toBe('reply_scope_invalid');

    // Its own inbound is fine, so the refusal is about scope, not about sends.
    const own = await fixture.service.sendFromCoordinator(secondCaller, {
      requestId: 'scope-own', channelBindingId: binding.bindingId, text: 'own', replyToInboundId: secondInbound,
    });
    expect(own.status).toBe('sent');
    expect(fixture.transport.sends).toHaveLength(1);
  });

  it('refuses a local turn that never received any inbound', async () => {
    const fixture = projectChannelsFixture();
    fixture.execution.strictAttempts = true;
    const { connection, binding } = await fixture.connected({ allowProactive: true });
    const inboundId = await fixture.service.handleInbound(
      inboundCallback(connection.connectionId, connection.generation),
    );

    // A local TUI turn on the same Coordinator: a live run, no channel scope.
    fixture.execution.strictAttempts = false;
    const localRun = await fixture.execution.startRun({
      sessionId: fixture.coordinatorId, prompt: 'local question', source: 'project_channel',
      inboundId: 'none', bindingId: 'none', projectId: PROJECT_ID,
    });
    expect(localRun.accepted).toBe(true);
    fixture.execution.strictAttempts = true;
    const live = fixture.execution.liveAttempt(fixture.coordinatorId)!;
    const caller = { ...live, projectId: PROJECT_ID };

    expect(await codeOf(() => fixture.service.sendFromCoordinator(caller, {
      requestId: 'scope-local', channelBindingId: binding.bindingId, text: 'pretend reply',
      replyToInboundId: inboundId,
    }))).toBe('reply_scope_invalid');
    expect(fixture.transport.sends).toHaveLength(0);
  });

  it('refuses a settled run and a superseded epoch', async () => {
    const fixture = projectChannelsFixture();
    fixture.execution.strictAttempts = true;
    const { binding, inboundId, attempt, caller } = await deliveredInbound(fixture);

    // The run settled while the tool call was in flight.
    fixture.execution.retire(fixture.coordinatorId);
    expect(await codeOf(() => fixture.service.sendFromCoordinator(caller, {
      requestId: 'scope-settled', channelBindingId: binding.bindingId, text: 'late',
      replyToInboundId: inboundId,
    }))).toBe('reply_scope_invalid');

    // The same run id under a new epoch is a different attempt.
    expect(await codeOf(() => fixture.service.sendFromCoordinator(
      { ...caller, epoch: attempt.epoch + 1 },
      { requestId: 'scope-epoch', channelBindingId: binding.bindingId, text: 'late', replyToInboundId: inboundId },
    ))).toBe('reply_scope_invalid');
    expect(fixture.transport.sends).toHaveLength(0);
  });

  it('refuses a replaced Coordinator that still holds the old Session id', async () => {
    const fixture = projectChannelsFixture();
    fixture.execution.strictAttempts = true;
    const { binding, inboundId, caller } = await deliveredInbound(fixture);

    // Rebind the project to a new Coordinator without retargeting the event.
    fixture.projects.bindCoordinatorSession(PROJECT_ID, 'coordinator-a2');

    expect(await codeOf(() => fixture.service.sendFromCoordinator(caller, {
      requestId: 'scope-swap', channelBindingId: binding.bindingId, text: 'still here',
      replyToInboundId: inboundId,
    }))).toBe('reply_scope_invalid');
    expect(fixture.transport.sends).toHaveLength(0);
  });

  it('refuses a proactive send from a run that is no longer live', async () => {
    const fixture = projectChannelsFixture({ allowProactive: true });
    fixture.execution.strictAttempts = true;
    const { binding, caller } = await deliveredInbound(fixture);

    fixture.execution.retire(fixture.coordinatorId);
    expect(await codeOf(() => fixture.service.sendFromCoordinator(caller, {
      requestId: 'scope-proactive', channelBindingId: binding.bindingId, text: 'unsolicited',
    }))).toBe('proactive_not_allowed');
    expect(fixture.transport.sends).toHaveLength(0);
  });
});
