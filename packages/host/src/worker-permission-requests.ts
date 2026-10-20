import type {
  HostPermissionRequest,
  HostPermissionRequestApiV1,
  HostPermissionRequestCreateInput,
  HostPermissionRequestResolveInput,
} from '@duya/agent-protocol';

interface PendingRequest {
  readonly sessionId: string;
  readonly runId: string;
  readonly expiresAt: number;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** Connect the existing HTTP approval API to the worker that is waiting. */
export class WorkerPermissionRequests implements HostPermissionRequestApiV1 {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly resolving = new Set<string>();

  constructor(
    private readonly records: HostPermissionRequestApiV1,
    private readonly send: (sessionId: string, message: Record<string, unknown>) => boolean,
    private readonly isLive: (sessionId: string, runId: string) => boolean,
  ) {}

  createPermissionRequest(input: HostPermissionRequestCreateInput): Promise<HostPermissionRequest> {
    return this.records.createPermissionRequest(input);
  }

  getPermissionRequest(id: string): Promise<HostPermissionRequest | null> {
    return this.records.getPermissionRequest(id);
  }

  listPendingPermissionRequests(sessionId?: string): Promise<readonly HostPermissionRequest[]> {
    return this.records.listPendingPermissionRequests(sessionId);
  }

  async request(sessionId: string, runId: string, request: Record<string, unknown>): Promise<void> {
    const id = typeof request.id === 'string' ? request.id : '';
    const toolName = typeof request.toolName === 'string' ? request.toolName : '';
    if (id === '' || toolName === '' || this.pending.has(id)) throw new Error('Invalid or duplicate worker permission request');
    const input = request.toolInput;
    const toolInput = input !== null && typeof input === 'object' && !Array.isArray(input)
      ? input as Record<string, unknown> : {};
    const expiresAt = typeof request.expiresAt === 'number' && Number.isFinite(request.expiresAt)
      ? Math.min(request.expiresAt, Date.now() + 300_000) : Date.now() + 300_000;
    // The worker's own words, kept. `mode` says which question is being
    // asked, `reason` says why — neither is derivable from the tool name,
    // and a client that reconstructs them is guessing. A client that reads
    // the ledger back has to show what the worker actually said.
    const mode = typeof request.mode === 'string' ? request.mode : null;
    const reason = typeof request.reason === 'string' ? request.reason : null;
    await this.records.createPermissionRequest({ id, sessionId, toolName, toolInput, mode, expiresAt, reason });
    if (!this.isLive(sessionId, runId)) {
      await this.records.resolvePermissionRequest(id, { status: 'aborted', decision: 'deny' });
      return;
    }
    const timer = setTimeout(() => {
      void this.resolvePermissionRequest(id, { status: 'timeout', decision: 'deny' }).catch(() => {
        // Fail closed even if persistence is unavailable at the deadline.
        this.send(sessionId, { type: 'permission:resolve', sessionId, id, decision: 'deny' });
        this.pending.delete(id);
      });
    }, Math.max(0, expiresAt - Date.now()));
    timer.unref?.();
    this.pending.set(id, { sessionId, runId, expiresAt, timer });
  }

  async resolvePermissionRequest(id: string, input: HostPermissionRequestResolveInput): Promise<HostPermissionRequest | null> {
    if (this.resolving.has(id)) return null;
    const pending = this.pending.get(id);
    if (pending === undefined) {
      const record = await this.records.getPermissionRequest(id);
      if (record === null || record.status !== 'pending' || this.resolving.has(id)) return null;
      return this.records.resolvePermissionRequest(id, input);
    }
    if (input.status === 'pending') return null;
    // Claim synchronously so concurrent HTTP replies cannot deliver twice.
    this.pending.delete(id);
    this.resolving.add(id);
    clearTimeout(pending.timer);
    const live = this.isLive(pending.sessionId, pending.runId);
    const expired = Date.now() >= pending.expiresAt;
    const resolution: HostPermissionRequestResolveInput = !live
      ? { status: 'aborted', decision: 'deny' }
      : expired ? { status: 'timeout', decision: 'deny' } : input;
    let record: HostPermissionRequest | null;
    try {
      record = await this.records.resolvePermissionRequest(id, resolution);
    } catch (error) {
      this.send(pending.sessionId, { type: 'permission:resolve', sessionId: pending.sessionId, id, decision: 'deny' });
      throw error;
    } finally {
      this.resolving.delete(id);
    }
    if (this.isLive(pending.sessionId, pending.runId)) {
      const allow = record?.status === 'allow' && Date.now() < pending.expiresAt;
      const sent = this.send(pending.sessionId, {
        type: 'permission:resolve',
        sessionId: pending.sessionId,
        id,
        decision: allow ? record?.decision === 'allow_for_session' ? 'allow_for_session' : 'allow_once' : 'deny',
        ...(allow && record?.updatedInput != null ? { updatedInput: record.updatedInput } : {}),
      });
      if (!sent) throw new Error('Permission decision could not reach the worker');
    }
    return record;
  }

  async closeSession(sessionId: string, runId?: string): Promise<void> {
    await Promise.all([...this.pending].filter(([, pending]) => pending.sessionId === sessionId && (runId === undefined || pending.runId === runId))
      .map(([id]) => this.resolvePermissionRequest(id, { status: 'aborted', decision: 'deny' })));
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.pending.keys()].map((id) => this.resolvePermissionRequest(id, { status: 'aborted', decision: 'deny' })));
  }
}
