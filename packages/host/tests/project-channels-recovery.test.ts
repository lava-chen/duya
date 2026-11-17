/**
 * project-channels-recovery.test.ts — restart and crash boundaries.
 *
 * Every case here is "the process died at this point": mid-send, after a claim,
 * before a claim, before an attach. The rule the tests enforce is the plan's:
 * the Host resumes what it can PROVE, refuses to guess about the rest, and
 * never turns an unknown into a second message.
 */

import { describe, expect, it } from 'vitest';
import { SessionStore } from '@duya/data/session-store';
import { ProjectChannelStore } from '@duya/data';
import {
  BOT_USER_ID,
  CHANNEL_ID,
  GUILD_ID,
  MEMBER_ID,
  PROJECT_ID,
  FakeTransport,
  projectChannelsFixture,
} from './project-channels-fixture.js';
import { createProjectChannelHostService } from '../src/project-channels/service.js';
import { createProjectChannelPendingIndex } from '../src/project-channels/pending.js';

describe('boot recovery', () => {
  it('starts enabled connections and records a missing credential as an error, not as online', async () => {
    const fixture = projectChannelsFixture();
    const { connection } = await fixture.connected();
    await fixture.secrets.remove(connection.connectionId);
    fixture.transport.starts.length = 0;

    const report = await fixture.service.start();
    expect(report.connectionErrors).toBe(1);
    expect(report.connectionsStarted).toBe(0);
    expect(fixture.transport.starts).toHaveLength(0);
    const observation = fixture.channels.getObservation(connection.connectionId);
    expect(observation?.state).toBe('error');
    expect(observation?.errorCode).toBe('credential_not_configured');
  });

  it('does not start a disconnected connection', async () => {
    const fixture = projectChannelsFixture();
    const { connection } = await fixture.connected();
    await fixture.service.disconnectConnection({
      projectId: PROJECT_ID, connectionId: connection.connectionId, requestId: 'off', expectedRevision: connection.revision,
    });
    fixture.transport.starts.length = 0;
    const report = await fixture.service.start();
    expect(report.connectionsStarted).toBe(0);
    expect(fixture.transport.starts).toHaveLength(0);
  });

  it('settles a delivery left mid-send as unknown and never resends it', async () => {
    const fixture = projectChannelsFixture({ allowProactive: true });
    const { binding } = await fixture.connected({ allowProactive: true });
    // Simulate the crash: a row claimed and never settled.
    const created = fixture.channels.createDelivery({
      deliveryId: 'delivery-crashed',
      projectId: PROJECT_ID,
      bindingId: binding.bindingId,
      bindingRevision: binding.revision,
      connectionId: binding.connectionId,
      connectionRevision: 1,
      requestId: 'send-crashed',
      body: { bindingId: binding.bindingId, text: 'did it arrive?', replyToInboundId: null },
      replyToInboundId: null,
      now: 10_000,
    });
    fixture.channels.claimDelivery(created.record.deliveryId, 10_100);

    const report = await fixture.service.recover();
    expect(report.deliveriesMarkedUnknown).toBe(1);
    const settled = fixture.channels.getDelivery('delivery-crashed');
    expect(settled?.status).toBe('unknown');
    expect(settled?.reason).toBe('interrupted_while_sending');
    // No receipt, no resend — the only honest answer is "unknown".
    expect(fixture.transport.sends).toHaveLength(0);
  });

  it('marks a claimed-but-unsettled input as recovery_required without starting a run', async () => {
    const fixture = projectChannelsFixture();
    const { connection } = await fixture.connected();
    fixture.execution.busy.add(fixture.coordinatorId);
    const inboundId = await fixture.service.handleInbound(
      { ...inboundCallbackBase(connection.connectionId, connection.generation) },
    );
    // The drainer claimed the row and died before recording an outcome.
    fixture.sessionInputs.claimPending(fixture.coordinatorId, inboundId);
    fixture.execution.busy.delete(fixture.coordinatorId);

    const report = await fixture.service.recover();
    expect(report.inboundsRecoveryRequired).toBe(1);
    expect(fixture.execution.starts).toHaveLength(0);
    const receipt = fixture.sessionInputs.get(fixture.coordinatorId, inboundId);
    expect(receipt?.stage).toBe('queued');
    expect(receipt?.reason).toBe('recovery_required');
    // The body is still on disk for whoever reconciles it.
    expect(fixture.channels.getInbound(inboundId)?.text).toContain('login task');
  });

  it('resumes an event that was persisted but never attached', async () => {
    const fixture = projectChannelsFixture();
    const { connection } = await fixture.connected();
    // Persistence succeeded, the attach never happened.
    const inbound = fixture.channels.acceptInbound({
      inboundId: 'inbound-orphan',
      connectionId: connection.connectionId,
      generation: connection.generation,
      bindingId: fixture.channels.listBindings(PROJECT_ID)[0]!.bindingId,
      bindingRevision: 1,
      body: {
        platformMessageId: 'platform-orphan',
        text: 'orphaned but durable',
        senderId: MEMBER_ID,
        mentionIds: [BOT_USER_ID],
        guildId: GUILD_ID,
        channelId: CHANNEL_ID,
        receivedAt: 9_000,
      },
      now: 9_000,
    }).record;
    expect(inbound.inputId).toBeNull();

    const report = await fixture.service.recover();
    expect(report.inboundsResumed).toBe(1);
    expect(fixture.execution.starts).toHaveLength(1);
    const attached = fixture.channels.getInbound('inbound-orphan');
    expect(attached?.targetSessionId).toBe(fixture.coordinatorId);
    expect(attached?.inputId).not.toBeNull();
  });

  it('resolves an unsubmitted event against the CURRENT Coordinator after a swap', async () => {
    const fixture = projectChannelsFixture();
    const { connection } = await fixture.connected();
    fixture.channels.acceptInbound({
      inboundId: 'inbound-before-swap',
      connectionId: connection.connectionId,
      generation: connection.generation,
      bindingId: fixture.channels.listBindings(PROJECT_ID)[0]!.bindingId,
      bindingRevision: 1,
      body: {
        platformMessageId: 'platform-before-swap',
        text: 'who is in charge now?',
        senderId: MEMBER_ID,
        mentionIds: [BOT_USER_ID],
        guildId: GUILD_ID,
        channelId: CHANNEL_ID,
        receivedAt: 9_000,
      },
      now: 9_000,
    });

    // A replacement Coordinator: the Project keeps pointing at the project, and
    // only the Session binding moves.
    fixture.sessions.create({ id: 'coordinator-a2', title: 'Alpha 协调 2', agentProfileId: 'project-coordinator' });
    fixture.projects.bindCoordinatorSession(PROJECT_ID, 'coordinator-a2');

    await fixture.service.recover();
    expect(fixture.execution.starts).toHaveLength(1);
    expect(fixture.execution.starts[0]!.sessionId).toBe('coordinator-a2');
    expect(fixture.channels.getInbound('inbound-before-swap')?.targetSessionId).toBe('coordinator-a2');
  });

  it('keeps a queued message across a Host restart and delivers it after the Session is free', async () => {
    const fixture = projectChannelsFixture();
    const { connection } = await fixture.connected();
    fixture.execution.busy.add(fixture.coordinatorId);
    const inboundId = await fixture.service.handleInbound(
      inboundCallbackBase(connection.connectionId, connection.generation),
    );
    expect(fixture.execution.starts).toHaveLength(0);

    // The Host goes away. Nothing is dropped: the queue is the database.
    await fixture.service.close();
    expect(fixture.transport.stops).toHaveLength(1);
    expect(fixture.sessionInputs.get(fixture.coordinatorId, inboundId)?.stage).toBe('persisted');

    // A new process over the same database.
    const secondTransport = new FakeTransport();
    let starts = 0;
    const secondService = createProjectChannelHostService({
      stores: {
        channels: new ProjectChannelStore(fixture.db),
        projects: fixture.projects,
        sessions: new SessionStore(fixture.db),
        sessionInputs: fixture.sessionInputs,
        leases: fixture.leases,
      },
      pending: createProjectChannelPendingIndex(fixture.db),
      transport: secondTransport,
      secrets: fixture.secrets,
      execution: {
        isSessionBusy: () => false,
        startRun: async () => {
          starts += 1;
          return { accepted: true as const, runId: `run-restart-${starts}` };
        },
      },
      ensureCoordinator: async () => ({ sessionId: fixture.coordinatorId }),
      now: () => 30_000,
      newId: () => `restart-${starts}-${Math.random().toString(16).slice(2)}`,
    });

    await secondService.start();
    expect(starts).toBe(1);
    expect(fixture.sessionInputs.get(fixture.coordinatorId, inboundId)?.stage).toBe('delivered');
    await secondService.close();
  });

  it('refuses events after close and still reports the durable delivery', async () => {
    const fixture = projectChannelsFixture({ allowProactive: true });
    const { connection, binding } = await fixture.connected({ allowProactive: true });
    const sent = await fixture.service.sendFromCoordinator({
      projectId: PROJECT_ID, sessionId: fixture.coordinatorId, runId: 'run-1', epoch: 0,
    }, { requestId: 'send-before-close', channelBindingId: binding.bindingId, text: 'bye' });
    await fixture.service.close();
    expect(fixture.channels.getDelivery(sent.deliveryId)?.status).toBe('sent');
    await expect(fixture.service.handleInbound(
      inboundCallbackBase(connection.connectionId, connection.generation),
    )).rejects.toMatchObject({ code: 'transport_unavailable' });
  });
});

function inboundCallbackBase(connectionId: string, generation: number) {
  return {
    connectionId,
    generation,
    platformMessageId: 'platform-message-1',
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    senderId: MEMBER_ID,
    authorIsBot: false,
    authorIsWebhook: false,
    mentionIds: [BOT_USER_ID],
    text: 'what is the status of the login task?',
    observedAt: 20_000,
  };
}
