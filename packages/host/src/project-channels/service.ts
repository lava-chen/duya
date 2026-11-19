/**
 * service.ts — the Host Project channel domain, assembly-ready.
 *
 * Three responsibilities live here and nowhere else:
 *
 * 1. **The control plane** (`HostProjectChannelApiV1`): configure a credential,
 *    bind a guild channel, revoke, disconnect, read back the overview. Every
 *    write is a CAS, every credential is verified against the platform BEFORE
 *    it is stored, and no output DTO ever carries a token.
 * 2. **Transport lifecycle**: start the enabled connections, fence callbacks by
 *    generation, and stop cleanly on close without dropping durable work.
 * 3. **Recovery**: settle interrupted sends as `unknown`, resume events that
 *    never reached a Session, and refuse to restart the ones nobody can
 *    interpret.
 *
 * It does NOT compose itself: no HTTP route, no CLI flag, no `local-host.ts`
 * edit. Plan E injects it. That boundary is why every dependency is a port and
 * why this file never imports the Gateway, Electron, or the decision to run a
 * Host at all.
 */

import type {
  ConfigureProjectChannelConnectionInput,
  CreateProjectChannelBindingInput,
  DisconnectProjectChannelInput,
  HostProjectChannelApiV1,
  ProjectChannelBinding,
  ProjectChannelConnection,
  ProjectChannelDelivery,
  ProjectChannelErrorCode,
  ProjectChannelInboundCallback,
  ProjectChannelOverview,
  ProjectChannelRuntimeObservation,
  ProjectChannelSendMessageInput,
  ProjectChannelSendResult,
  ProjectChannelTransportPort,
  RevokeProjectChannelBindingInput,
  UpdateProjectChannelBindingInput,
} from '@duya/agent-protocol/project-channels';
import { isProjectChannelErrorCode } from '@duya/agent-protocol/project-channels';
import {
  createProjectChannelInbound,
  type ProjectChannelInbound,
} from './inbound.js';
import {
  createProjectChannelOutbound,
  type ProjectChannelCaller,
  type ProjectChannelOutbound,
} from './outbound.js';
import type { ProjectChannelPendingIndex } from './pending.js';
import type { ProjectChannelSecretPort } from './secrets.js';
import {
  DEFAULT_CLOCK,
  ProjectChannelServiceError,
  errorCodeOf,
  projectChannelServiceError,
  type ProjectChannelContext,
  type ProjectChannelExecutionPort,
  type ProjectChannelHostStores,
  type ProjectChannelLogger,
} from './types.js';

export interface ProjectChannelHostServiceOptions {
  readonly stores: ProjectChannelHostStores;
  readonly pending: ProjectChannelPendingIndex;
  readonly transport: ProjectChannelTransportPort;
  readonly secrets: ProjectChannelSecretPort;
  readonly execution: ProjectChannelExecutionPort;
  /** The project domain's existing `ensureCoordinatorSession`; no new session kind. */
  readonly ensureCoordinator: (projectId: string) => Promise<{ readonly sessionId: string }>;
  /** Defaults are silent so an unwired Host does not invent console output. */
  readonly logger?: Partial<ProjectChannelLogger>;
  readonly now?: () => number;
  readonly newId?: () => string;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Discord's hard ceiling; longer text is refused rather than truncated. */
  readonly maxTextLength?: number;
}

export interface ProjectChannelRecoveryReport {
  /** Connections whose transport accepted a start during this call. */
  readonly connectionsStarted: number;
  /** Connections that could not start (missing credential, transport error). */
  readonly connectionErrors: number;
  /** Mid-send rows from a previous process, settled as `unknown`. */
  readonly deliveriesMarkedUnknown: number;
  /** Persisted events resumed into their current Coordinator. */
  readonly inboundsResumed: number;
  /** Claimed events whose outcome nobody can prove; never restarted. */
  readonly inboundsRecoveryRequired: number;
}

export interface ProjectChannelHostService extends HostProjectChannelApiV1 {
  /** Transport inbound handler; E passes it to `transport.start` — or lets `start()` do it. */
  handleInbound(callback: ProjectChannelInboundCallback): Promise<string>;
  handleObservation(observation: ProjectChannelRuntimeObservation): void;
  /** Start enabled connections and run recovery. Safe to call once. */
  start(): Promise<ProjectChannelRecoveryReport>;
  /** Reconcile durable work without touching the transport. */
  recover(): Promise<ProjectChannelRecoveryReport>;
  /** Hook for Run settle / Session idle: make progress on one Session's queue. */
  drainSession(sessionId: string): Promise<void>;
  drainProject(projectId: string): Promise<void>;
  /**
   * Whether this external turn already established a reply obligation for the
   * inbound. `queued`/`sending` count as established; a failed call does not.
   */
  hasReplyDelivery(inboundId: string): boolean;
  /** The Coordinator's `send_message` path, with caller facts the tool layer validated. */
  sendFromCoordinator(
    caller: ProjectChannelCaller,
    request: ProjectChannelSendMessageInput,
  ): Promise<ProjectChannelSendResult>;
  /** Stop receiving; durable queues and deliveries stay in the database. */
  close(): Promise<void>;
}

const SILENT_LOGGER: ProjectChannelLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const DEFAULT_MAX_TEXT_LENGTH = 2_000;

/**
 * Normalize a store/transport refusal into the domain error type while keeping
 * its code. A caller then branches on `code`, never on a message string.
 */
function asServiceError(error: unknown): unknown {
  if (error instanceof ProjectChannelServiceError) return error;
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && isProjectChannelErrorCode(code)) {
      return new ProjectChannelServiceError(code, (error as { message?: string }).message ?? code);
    }
  }
  return error;
}


export function createProjectChannelHostService(
  options: ProjectChannelHostServiceOptions,
): ProjectChannelHostService {
  const context: ProjectChannelContext = {
    stores: options.stores,
    transport: options.transport,
    secrets: options.secrets,
    execution: options.execution,
    ensureCoordinator: options.ensureCoordinator,
    isClosed: () => closed,
    logger: { ...SILENT_LOGGER, ...options.logger },
    clock: {
      now: options.now ?? DEFAULT_CLOCK.now,
      newId: options.newId ?? DEFAULT_CLOCK.newId,
      sleep: options.sleep ?? DEFAULT_CLOCK.sleep,
    },
    maxTextLength: options.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH,
  };
  const { stores, transport, secrets, clock } = context;
  const inbound: ProjectChannelInbound = createProjectChannelInbound(context);
  const outbound: ProjectChannelOutbound = createProjectChannelOutbound(context);

  /** Generation currently started per connection; also the stop list. */
  const running = new Map<string, number>();
  let closed = false;

  const handlers = {
    onInbound: (callback: ProjectChannelInboundCallback): Promise<string> => service.handleInbound(callback),
    onObservation: (observation: ProjectChannelRuntimeObservation): void => { service.handleObservation(observation); },
  };

  /**
   * Record what the transport observed. Persisted config is NOT runtime state:
   * a configured connection with a bad token must not read as "online".
   */
  function observe(
    connectionId: string,
    generation: number,
    state: ProjectChannelRuntimeObservation['state'],
    errorCode: ProjectChannelErrorCode | null,
    observedBotUserId: string | null = null,
  ): void {
    try {
      stores.channels.observe({
        connectionId,
        generation,
        observedBotUserId,
        state,
        errorCode,
        observedAt: clock.now(),
      });
    } catch (error) {
      context.logger.warn('Could not record project channel observation', {
        connectionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function startTransport(connection: ProjectChannelConnection, token: string): Promise<boolean> {
    try {
      const observation = await transport.start({
        connectionId: connection.connectionId,
        generation: connection.generation,
        token,
        handlers,
      });
      stores.channels.observe({
        connectionId: observation.connectionId,
        generation: observation.generation,
        observedBotUserId: observation.observedBotUserId,
        state: observation.state,
        errorCode: observation.errorCode,
        observedAt: observation.observedAt,
      });
      running.set(connection.connectionId, connection.generation);
      return true;
    } catch (error) {
      const code = errorCodeOf(error, 'transport_unavailable');
      observe(connection.connectionId, connection.generation, 'error', code);
      context.logger.warn('Project channel transport did not start', {
        connectionId: connection.connectionId,
        code,
      });
      return false;
    }
  }

  /** Resolve the credential, or refuse with the code that explains why. */
  async function requireSecret(connectionId: string): Promise<string> {
    const token = await secrets.read(connectionId);
    if (token === null) {
      throw projectChannelServiceError('credential_not_configured', 'connection has no stored credential');
    }
    return token;
  }

  function requireProject(projectId: string) {
    const project = stores.projects.get(projectId);
    if (project === null) throw projectChannelServiceError('project_not_found', 'project does not exist');
    return project;
  }

  const service: ProjectChannelHostService = {
    async handleInbound(callback) {
      if (closed) {
        throw projectChannelServiceError('transport_unavailable', 'channel service is closed');
      }
      try {
        return await inbound.accept(callback);
      } catch (error) {
        throw asServiceError(error);
      }
    },

    handleObservation(observation) {
      if (closed) return;
      // A live observation must never throw back into the transport's socket
      // loop: losing an observation is recoverable, losing the reader is not.
      try {
        stores.channels.observe({
          connectionId: observation.connectionId,
          generation: observation.generation,
          observedBotUserId: observation.observedBotUserId,
          state: observation.state,
          errorCode: observation.errorCode,
          observedAt: observation.observedAt,
        });
      } catch (error) {
        context.logger.warn('Could not record a project channel observation', {
          connectionId: observation.connectionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },

    async getProjectChannels(projectId, cursor, limit): Promise<ProjectChannelOverview | null> {
      const project = stores.projects.get(projectId);
      if (project === null) return null;
      const connections = stores.channels.listConnections(projectId);
      const connection = connections.find((row) => row.enabled)
        ?? connections[connections.length - 1]
        ?? null;
      return {
        projectId,
        connection,
        bindings: stores.channels.listBindings(projectId),
        observation: connection === null ? null : stores.channels.getObservation(connection.connectionId),
        deliveries: stores.channels.listDeliveries(
          projectId,
          cursor ?? 0,
          Math.max(1, Math.min(100, limit ?? 50)),
        ),
      };
    },

    async configureDiscordConnection(input: ConfigureProjectChannelConnectionInput): Promise<ProjectChannelConnection> {
      return guard(async () => {
        requireProject(input.projectId);
        const token = input.token.trim();
        if (token === '') throw projectChannelServiceError('invalid_request', 'token is required');
        if (input.requestId.trim() === '') throw projectChannelServiceError('invalid_request', 'requestId is required');

        const existing = stores.channels.getActiveConnectionForProject(input.projectId);
        if (existing !== null && input.expectedRevision === undefined) {
          // Reconfiguring an existing connection without saying which revision
          // it saw is a blind overwrite; refuse it instead of guessing.
          throw projectChannelServiceError('stale_revision', 'expectedRevision is required to change an existing connection');
        }
        if (existing === null && input.expectedRevision !== undefined) {
          throw projectChannelServiceError('stale_revision', 'no connection exists at the expected revision');
        }
        if (existing !== null && input.expectedRevision !== existing.revision) {
          throw projectChannelServiceError('stale_revision', 'connection revision changed');
        }

        const connectionId = existing?.connectionId ?? clock.newId();
        let verified;
        try {
          verified = await transport.verifyIdentity({ connectionId, token });
        } catch (error) {
          throw new ProjectChannelServiceError(
            errorCodeOf(error, 'transport_unavailable'),
            'the platform did not confirm this Bot identity',
          );
        }
        if (existing !== null && verified.botUserId !== existing.botUserId) {
          // A token for a different Bot is a different identity: rebuilding the
          // connection is a decision, not a side effect of a rotation.
          throw projectChannelServiceError('bot_identity_conflict', 'token belongs to a different Bot than this connection');
        }

        // Persist the credential only after the platform confirmed it. A row that
        // claims `credentialConfigured` for an unverified token would be a lie
        // the runtime cannot correct without another write.
        await secrets.write(connectionId, token);
        let connection;
        try {
          connection = existing === null
            ? stores.channels.createConnection({
              connectionId,
              projectId: input.projectId,
              requestId: input.requestId,
              botUserId: verified.botUserId,
              ...(input.label === undefined ? {} : { label: input.label }),
              now: clock.now(),
            }).record
            : stores.channels.rotateConnection({
              connectionId,
              expectedRevision: input.expectedRevision!,
              botUserId: verified.botUserId,
              now: clock.now(),
            });
        } catch (error) {
          // A refused first configuration must not leave a token behind for a
          // connection that does not exist. A refused ROTATION keeps the file it
          // just wrote: the token was verified for this same Bot, and the Host
          // owns the database, so the losing writer is a retry of the same user
          // action rather than a second process.
          if (existing === null) await secrets.remove(connectionId);
          throw error;
        }
        if (connection === null) throw projectChannelServiceError('connection_not_found', 'connection disappeared');
        // Configuration is saved whether or not the socket comes up; the
        // observation records the truth so a read never claims "online".
        await startTransport(connection, token);
        return stores.channels.getConnection(connection.connectionId) ?? connection;
      });
    },

    async createBinding(input: CreateProjectChannelBindingInput): Promise<ProjectChannelBinding> {
      return guard(async () => {
        requireProject(input.projectId);
        if (input.allowedUserIds.length === 0) {
          throw projectChannelServiceError('invalid_allowlist', 'binding allowlist must not be empty');
        }
        const connection = stores.channels.getActiveConnection(input.connectionId);
        if (connection === null || connection.projectId !== input.projectId) {
          throw projectChannelServiceError('connection_not_found', 'connection is not active for this project');
        }
        const token = await requireSecret(connection.connectionId);
        let inspection;
        try {
          inspection = await transport.inspectChannel({
            connectionId: connection.connectionId,
            token,
            guildId: input.guildId,
            channelId: input.channelId,
          });
        } catch (error) {
          throw new ProjectChannelServiceError(
            errorCodeOf(error, 'transport_unavailable'),
            'the platform did not confirm this channel',
          );
        }
        if (!inspection.isTextChannel || inspection.isThread) {
          // A thread must be bound on its own id; inheriting the parent channel's
          // authorization is exactly the shortcut the plan forbids.
          throw projectChannelServiceError('invalid_target', 'only a guild text channel can be bound');
        }
        return stores.channels.createBinding({
          bindingId: clock.newId(),
          projectId: input.projectId,
          requestId: input.requestId,
          connectionId: connection.connectionId,
          guildId: inspection.guildId,
          channelId: inspection.channelId,
          allowedUserIds: input.allowedUserIds,
          ...(input.allowProactive === undefined ? {} : { allowProactive: input.allowProactive }),
          ...(input.label === undefined ? {} : { label: input.label }),
          now: clock.now(),
        }).record;
      });
    },

    async updateBinding(input: UpdateProjectChannelBindingInput): Promise<ProjectChannelBinding | null> {
      return guard(async () => {
        try {
          return stores.channels.updateBinding({
            projectId: input.projectId,
            bindingId: input.bindingId,
            requestId: input.requestId,
            expectedRevision: input.expectedRevision,
            ...(input.allowedUserIds === undefined ? {} : { allowedUserIds: input.allowedUserIds }),
            ...(input.allowProactive === undefined ? {} : { allowProactive: input.allowProactive }),
            ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
            ...(input.label === undefined ? {} : { label: input.label }),
            now: clock.now(),
          });
        } catch (error) {
          if (errorCodeOf(error, 'internal') === 'binding_not_found') return null;
          throw error;
        }
      });
    },

    async revokeBinding(input: RevokeProjectChannelBindingInput): Promise<ProjectChannelBinding | null> {
      return guard(async () => {
        try {
          return stores.channels.revokeBinding({
            projectId: input.projectId,
            bindingId: input.bindingId,
            requestId: input.requestId,
            expectedRevision: input.expectedRevision,
            now: clock.now(),
          });
        } catch (error) {
          if (errorCodeOf(error, 'internal') === 'binding_not_found') return null;
          throw error;
        }
      });
    },

    async disconnectConnection(input: DisconnectProjectChannelInput): Promise<ProjectChannelConnection | null> {
      return guard(async () => {
        const existing = stores.channels.getConnection(input.connectionId);
        if (existing === null || existing.projectId !== input.projectId) return null;
        const connection = stores.channels.disconnectConnection({
          connectionId: input.connectionId,
          requestId: input.requestId,
          expectedRevision: input.expectedRevision,
          now: clock.now(),
        });
        if (connection === null) return null;
        const generation = running.get(input.connectionId);
        if (generation !== undefined) {
          try { await transport.stop(input.connectionId, generation); }
          catch { /* A transport that is already down is not a disconnect failure. */ }
          running.delete(input.connectionId);
        }
        // The stored credential is deliberately kept: disconnecting stops traffic
        // and does not claim the remote token was revoked. Forgetting it is a
        // separate, explicit act.
        return connection;
      });
    },

    async getDelivery(projectId, deliveryId): Promise<ProjectChannelDelivery | null> {
      const delivery = stores.channels.getDelivery(deliveryId);
      return delivery !== null && delivery.projectId === projectId ? delivery : null;
    },

    async start(): Promise<ProjectChannelRecoveryReport> {
      if (closed) throw projectChannelServiceError('transport_unavailable', 'channel service is closed');
      let connectionsStarted = 0;
      let connectionErrors = 0;
      for (const connection of stores.channels.listConnections()) {
        if (!connection.enabled) continue;
        const token = await secrets.read(connection.connectionId);
        if (token === null) {
          observe(connection.connectionId, connection.generation, 'error', 'credential_not_configured');
          connectionErrors += 1;
          continue;
        }
        if (await startTransport(connection, token)) connectionsStarted += 1;
        else connectionErrors += 1;
      }
      const report = await recoverInternal();
      context.logger.info('Project channel service started', { ...report });
      return { ...report, connectionsStarted, connectionErrors };
    },

    async recover(): Promise<ProjectChannelRecoveryReport> {
      return recoverInternal();
    },

    async drainSession(sessionId) {
      if (closed) return;
      await inbound.drainSession(sessionId);
    },

    async drainProject(projectId) {
      if (closed) return;
      await inbound.drainProject(projectId);
    },

    hasReplyDelivery(inboundId) {
      return options.pending.hasReplyDelivery(inboundId);
    },

    async sendFromCoordinator(caller, request) {
      if (closed) throw projectChannelServiceError('transport_unavailable', 'channel service is closed');
      try {
        return await outbound.send(caller, request);
      } catch (error) {
        throw asServiceError(error);
      }
    },

    async close() {
      if (closed) return;
      closed = true;
      for (const [connectionId, generation] of [...running]) {
        try {
          await transport.stop(connectionId, generation);
        } catch (error) {
          context.logger.warn('Could not stop project channel transport', {
            connectionId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      running.clear();
      // Durable queues and deliveries are untouched on purpose: stopping the
      // Host must not lose an accepted message or an owed reply.
    },
  };

  /**
   * Recovery, in the order the evidence allows.
   *
   * 1. Mid-send deliveries have no receipt → `unknown`. Nothing resends them.
   * 2. Claimed inputs have no provable outcome → `recovery_required`. The body
   *    is still on disk; a human (or a later explicit reconcile) decides.
   * 3. Persisted-but-unattached events were never submitted anywhere → safe to
   *    resolve against the CURRENT Coordinator.
   * 4. Then let the normal drain run, which respects busy/lease.
   */
  async function recoverInternal(): Promise<ProjectChannelRecoveryReport> {
    const deliveriesMarkedUnknown = outbound.reclaimInterrupted(options.pending.listSendingDeliveryIds());

    const claimed = options.pending.listQueuedInputs();
    for (const item of claimed) {
      stores.sessionInputs.advanceStage(item.sessionId, item.requestId, 'queued', { reason: 'recovery_required' });
    }

    let inboundsResumed = 0;
    for (const inboundId of options.pending.listUnsubmittedInboundIds()) {
      const record = stores.channels.getInbound(inboundId);
      if (record === null) continue;
      try {
        await inbound.resume(record);
        inboundsResumed += 1;
      } catch (error) {
        context.logger.warn('Could not resume a project channel inbound', {
          inboundId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    for (const project of stores.projects.list()) {
      if (stores.channels.listBindings(project.project_id).length === 0) continue;
      try {
        await inbound.drainProject(project.project_id);
      } catch (error) {
        context.logger.warn('Could not drain a project channel queue', {
          projectId: project.project_id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      connectionsStarted: 0,
      connectionErrors: 0,
      deliveriesMarkedUnknown,
      inboundsResumed,
      inboundsRecoveryRequired: claimed.length,
    };
  }

  /** Convert store/transport codes into the domain error type; keep everything else. */
  async function guard<T>(run: () => Promise<T>): Promise<T> {
    if (closed) throw projectChannelServiceError('transport_unavailable', 'channel service is closed');
    try {
      return await run();
    } catch (error) {
      throw asServiceError(error);
    }
  }

  return service;
}
