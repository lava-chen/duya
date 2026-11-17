/**
 * project-channels-fixture.ts — a real core database plus a controlled platform.
 *
 * The store, the receipts, the lease and the queue all run on real SQLite with
 * the real migrations: a fake map would let a uniqueness or CAS bug pass. The
 * transport is the only fake, because the platform is the one thing a unit test
 * cannot host — and keeping it explicit is how the "no blind resend" tests can
 * assert exactly how many sends left the Host.
 */

import Database from 'better-sqlite3';
import { afterEach } from 'vitest';
import {
  PROJECT_CHANNEL_MIGRATIONS,
  ProjectChannelStore,
  SESSION_CONTROL_LEASE_MIGRATIONS,
  SESSION_INPUT_MIGRATIONS,
  SessionControlLeaseStore,
  SessionInputStore,
} from '@duya/data';
import type {
  ProjectChannelInboundCallback,
  ProjectChannelRuntimeObservation,
  ProjectChannelTransportPort,
} from '@duya/agent-protocol/project-channels';
import { ProjectStore } from '@duya/data/project-store';
import { SessionStore } from '@duya/data/session-store';
import { createProjectChannelHostService, type ProjectChannelHostService } from '../src/project-channels/index.js';
import { createInMemoryProjectChannelSecrets } from '../src/project-channels/secrets.js';
import { createProjectChannelPendingIndex } from '../src/project-channels/pending.js';
import type { ProjectChannelExecutionPort } from '../src/project-channels/types.js';

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

export const PROJECT_ID = 'project-a';
export const COORDINATOR_ID = 'coordinator-a';
export const BOT_USER_ID = 'bot-a';
export const GUILD_ID = 'guild-1';
export const CHANNEL_ID = 'channel-1';
export const MEMBER_ID = 'member-1';
export const CONNECTION_TOKEN = 'token-a';

export type SendOutcome = Awaited<ReturnType<ProjectChannelTransportPort['send']>>;
export type StartOutcome = Awaited<ReturnType<ProjectChannelTransportPort['start']>>;

export class FakeTransport implements ProjectChannelTransportPort {
  readonly starts: Parameters<ProjectChannelTransportPort['start']>[0][] = [];
  readonly stops: Array<{ connectionId: string; generation: number }> = [];
  readonly sends: Parameters<ProjectChannelTransportPort['send']>[0][] = [];
  /** Queued outcomes for `send`; the last one repeats. */
  sendOutcomes: SendOutcome[] = [{ platformMessageId: 'platform-msg-1' }];
  /** Tokens the platform accepts, mapped to the Bot they belong to. */
  readonly identities = new Map<string, string>([[CONNECTION_TOKEN, BOT_USER_ID]]);
  inspection: { guildId: string; channelId: string; isTextChannel: boolean; isThread: boolean } = {
    guildId: GUILD_ID, channelId: CHANNEL_ID, isTextChannel: true, isThread: false,
  };
  failStart = false;
  throwOnSend: Error | null = null;
  private readonly observations = new Map<string, ProjectChannelRuntimeObservation>();

  async start(input: Parameters<ProjectChannelTransportPort['start']>[0]): Promise<StartOutcome> {
    if (this.failStart) throw Object.assign(new Error('socket refused'), { code: 'transport_unavailable' });
    this.starts.push(input);
    const observation: ProjectChannelRuntimeObservation = {
      connectionId: input.connectionId,
      generation: input.generation,
      observedBotUserId: BOT_USER_ID,
      state: 'connected',
      errorCode: null,
      observedAt: 5_000,
    };
    this.observations.set(input.connectionId, observation);
    return observation;
  }

  async stop(connectionId: string, generation: number): Promise<void> {
    this.stops.push({ connectionId, generation });
  }

  observe(connectionId: string): ProjectChannelRuntimeObservation | null {
    return this.observations.get(connectionId) ?? null;
  }

  async verifyIdentity(input: Parameters<ProjectChannelTransportPort['verifyIdentity']>[0]) {
    const botUserId = this.identities.get(input.token);
    if (botUserId === undefined) {
      throw Object.assign(new Error('discord said 401'), { code: 'credential_invalid' });
    }
    return { botUserId, verifiedAt: 4_000 };
  }

  async inspectChannel(input: Parameters<ProjectChannelTransportPort['inspectChannel']>[0]) {
    if (input.guildId !== this.inspection.guildId || input.channelId !== this.inspection.channelId) {
      throw Object.assign(new Error('unknown channel'), { code: 'invalid_target' });
    }
    return { ...this.inspection, inspectedAt: 4_100 };
  }

  async send(input: Parameters<ProjectChannelTransportPort['send']>[0]): Promise<SendOutcome> {
    this.sends.push(input);
    if (this.throwOnSend !== null) throw this.throwOnSend;
    const outcome = this.sendOutcomes.length > 1 ? this.sendOutcomes.shift()! : this.sendOutcomes[0]!;
    return outcome;
  }
}

export interface StartRunCall {
  readonly sessionId: string;
  readonly prompt: string;
  readonly source: 'project_channel';
  readonly inboundId: string;
  readonly bindingId: string;
  readonly projectId: string;
}

export class FakeExecution implements ProjectChannelExecutionPort {
  readonly starts: StartRunCall[] = [];
  readonly busy = new Set<string>();
  /** When set, the next start is refused with this stage. */
  refuseWith: string | null = null;

  isSessionBusy(sessionId: string): boolean {
    return this.busy.has(sessionId);
  }

  async startRun(input: StartRunCall) {
    this.starts.push(input);
    if (this.refuseWith !== null) {
      return { accepted: false as const, stage: 'refused_run_open_failed', reason: this.refuseWith };
    }
    return { accepted: true as const, runId: `run-${this.starts.length}` };
  }
}

export interface FixtureOptions {
  /** Second project, to prove cross-project isolation. */
  readonly withSecondProject?: boolean;
  readonly allowProactive?: boolean;
}

export function projectChannelsFixture(options: FixtureOptions = {}) {
  const db = new Database(':memory:');
  databases.push(db);
  db.pragma('foreign_keys = ON');
  const migrations = [
    ...SessionStore.migrations,
    ...ProjectStore.migrations,
    ...SESSION_INPUT_MIGRATIONS,
    ...SESSION_CONTROL_LEASE_MIGRATIONS,
    ...PROJECT_CHANNEL_MIGRATIONS,
  ].sort((a, b) => a.id - b.id);
  for (const migration of migrations) migration.up(db);

  const sessions = new SessionStore(db);
  const projects = new ProjectStore(db);
  const channels = new ProjectChannelStore(db);
  const sessionInputs = new SessionInputStore(db);
  const leases = new SessionControlLeaseStore(db);

  projects.insert({ project_id: PROJECT_ID, canonical_root: '/projects/a', name: 'Alpha' });
  projects.bindCoordinatorSession(PROJECT_ID, COORDINATOR_ID);
  sessions.create({ id: COORDINATOR_ID, title: 'Alpha 协调', agentProfileId: 'project-coordinator' });

  if (options.withSecondProject === true) {
    projects.insert({ project_id: 'project-b', canonical_root: '/projects/b', name: 'Beta' });
    projects.bindCoordinatorSession('project-b', 'coordinator-b');
    sessions.create({ id: 'coordinator-b', title: 'Beta 协调', agentProfileId: 'project-coordinator' });
  }

  const transport = new FakeTransport();
  const execution = new FakeExecution();
  const secrets = createInMemoryProjectChannelSecrets();

  let nextId = 0;
  // One clock the test can move: lease expiry and queue retries depend on it.
  let nowMs = 10_000;
  const service: ProjectChannelHostService = createProjectChannelHostService({
    stores: {
      channels,
      projects,
      sessions,
      sessionInputs,
      leases,
    },
    pending: createProjectChannelPendingIndex(db),
    transport,
    secrets,
    execution,
    ensureCoordinator: async (projectId) => {
      const project = projects.get(projectId);
      if (project === null || project.coordinator_session_id === null) {
        throw new Error(`no coordinator for ${projectId}`);
      }
      return { sessionId: project.coordinator_session_id };
    },
    now: () => nowMs,
    newId: () => `id-${(nextId += 1)}`,
    sleep: async () => {},
  });

  return {
    db, sessions, projects, channels, sessionInputs, leases,
    transport, execution, secrets, service,
    setNow(value: number) { nowMs = value; },
    projectId: PROJECT_ID,
    coordinatorId: COORDINATOR_ID,
    // Convenience: a configured connection and binding, the state every
    // inbound/outbound case starts from.
    async connected(bindingOverrides: { allowProactive?: boolean; allowedUserIds?: string[]; label?: string } = {}) {
      const connection = await service.configureDiscordConnection({
        projectId: PROJECT_ID, requestId: 'cfg-1', token: CONNECTION_TOKEN, label: 'Alpha Bot',
      });
      const binding = await service.createBinding({
        projectId: PROJECT_ID,
        requestId: 'bind-1',
        connectionId: connection.connectionId,
        guildId: GUILD_ID,
        channelId: CHANNEL_ID,
        allowedUserIds: bindingOverrides.allowedUserIds ?? [MEMBER_ID],
        allowProactive: bindingOverrides.allowProactive ?? options.allowProactive ?? false,
        ...(bindingOverrides.label === undefined ? {} : { label: bindingOverrides.label }),
      });
      return { connection, binding };
    },
  };
}

export function inboundCallback(
  connectionId: string,
  generation: number,
  overrides: Partial<ProjectChannelInboundCallback> = {},
): ProjectChannelInboundCallback {
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
    ...overrides,
  };
}
