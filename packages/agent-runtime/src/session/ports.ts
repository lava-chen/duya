/**
 * The ports the Runtime Session service depends on.
 *
 * ## Why ports and not a service object
 *
 * The Runtime is the layer that must not know how storage, models or processes
 * are wired. The R1.0 audit showed the Host holds all of that: the manifest
 * factory, the run control plane, the worker supervisor, the SQLite stores.
 * Handing the Runtime "the Host" would make every Host change a Runtime
 * change and would put the package boundary back where it was before this
 * migration started.
 *
 * So the Runtime declares the three things it needs and the Host supplies
 * them. Each port is deliberately narrow enough that one Host fact fills it
 * exactly.
 *
 * ## What a Session is allowed to know
 *
 * A Session knows which workspace it is operating in and what it was told to
 * do. It does NOT know about projects.
 *
 * That is not an omission. The R1.0 audit established that the session tables
 * carry no project identity at all — `project_name` is a free-text display
 * string that nothing can join on — and that the only real project foreign
 * key is `workspaces.project_id`, a nullable label on the workspace, not on
 * the session. Project identity enters the product in exactly two places: the
 * client resolving a project from a working directory, and the prompt layer
 * reading the project's seeded instruction file. Both live outside the
 * Session service, and both stay outside it.
 *
 * The workspace reference below is therefore the whole of "where am I": an
 * opaque workspace id, a root id, and a path RELATIVE to that root. It cannot
 * express `..`, so a session structurally cannot address a directory outside
 * its own workspace — no permission check needed for a path the shape cannot
 * represent.
 */

/**
 * Where a session operates.
 *
 * Mirrors the `bound` arm of the Host's workspace binding on purpose: two
 * shapes for one fact drift, and the Host's shape is the one already on the
 * wire. It carries identifiers, never a resolved filesystem path — the Host
 * resolves those, and a runtime that knew them would be one refactor away
 * from leaking them into a prompt or an event.
 */
export interface SessionWorkspace {
  readonly workspaceId: string;
  readonly rootId: string | null;
  readonly relativePath: string;
}

/**
 * What the caller asked the session to do.
 *
 * This is an INPUT, and it stays an input. It deliberately carries no
 * manifest, no run identity and no configuration: those are the Host's to
 * freeze. A request that carried them would be a second authority — the Host
 * would have to either trust the caller's frozen configuration or reject it,
 * and rejecting it would mean the Host had two ways to produce a manifest.
 */
export interface SessionRunRequest {
  readonly sessionId: string;
  readonly workspace: SessionWorkspace;
  /** The user's turn, as text. The Runtime does not interpret it. */
  readonly prompt: string;
  /** The caller's correlation id. Not the run id — the Host mints that. */
  readonly requestId: string;
  /** Cancellation for the caller's own wait, not the run's. */
  readonly signal?: AbortSignal;
}

/**
 * The run identity the Host froze.
 *
 * A run that was admitted has one, and it is the Host's. The Runtime never
 * mints one, because a Runtime-minted id would have to be reconciled with
 * the Host's durable run row, and two ids for one run is exactly the class
 * of bug this migration exists to remove.
 */
export interface SessionRunIdentity {
  readonly runId: string;
  /**
   * The frozen configuration, as the Host computed it.
   *
   * It comes back in the admission result rather than being sent in the
   * request, so the caller cannot influence it and the Runtime cannot
   * recompute it.
   */
  readonly manifestHash: string;
}

/**
 * Why an admission did not happen.
 *
 * The three states are not decoration. R1.0 found that the Host currently
 * collapses five internal failure modes into one wire stage, and that the
 * collapsed bucket mixes "the session is busy" (wait), "this exact run
 * already exists" (reconcile against the receipt) and "the run row was never
 * written" (retry, and alert). Those need different next steps, so a port
 * that answered with a boolean would force the caller to guess which one it
 * got.
 */
export type SessionAdmissionOutcome =
  /** The Host accepted the request and froze a run. */
  | { readonly state: 'admitted'; readonly identity: SessionRunIdentity }
  /**
   * The Host read the request and refused it on policy.
   *
   * Retrying the same request will be refused the same way: the refusal is a
   * property of the request and the session's state, not of the moment.
   */
  | { readonly state: 'rejected'; readonly reason: string }
  /**
   * The Host could not be reached, or answered something unusable.
   *
   * Retrying is meaningful here, and the distinction from `rejected` is the
   * whole reason this port has three states.
   */
  | { readonly state: 'failed'; readonly reason: string };

/**
 * How a session asks the Host to start a run.
 *
 * The Host implementation calls the control plane's atomic operations
 * directly. It must NOT call a public start entry that forwards back into
 * this service: that is a recursion, and it is the failure mode the R1 plan
 * names explicitly. The direction is one-way — the Runtime asks, the Host
 * decides.
 */
export interface SessionAdmissionPort {
  admit(request: SessionRunRequest): Promise<SessionAdmissionOutcome>;
}

/**
 * How a session stops a run.
 *
 * Optional on purpose. A Host with no remote execution surface has nothing to
 * cancel, and forcing it to write an empty implementation would put a method
 * on the interface that silently does nothing — the exact kind of stub that
 * makes a caller believe it asked for a cancellation.
 */
export interface SessionExecutionPort {
  cancel(runId: string, reason?: string): Promise<boolean>;
}

/**
 * The storage ports the history restore needs.
 *
 * The row and message shapes are the Host's — a SQLite row is a SQLite row —
 * but the ORDER of the restore is the Runtime's concern, and that order is
 * what this migration is moving. The shapes stay generic so the Runtime does
 * not have to import the Host's row types to describe a sequence of steps.
 */
export interface SessionHistoryLoad<Row, ParsedDocument extends { readonly message_id: string }> {
  readonly messages: readonly Row[];
  readonly parsedDocuments?: readonly ParsedDocument[];
}

/** The outcome of writing a repaired history back. */
export interface SessionHistoryRepairResult {
  readonly success?: boolean;
  readonly reason?: string;
}

/**
 * The ports the history restore is written against.
 *
 * Every one of them is an operation, not a store handle. A store handle would
 * make the Runtime depend on the shape of the database; an operation list
 * makes it depend on the shape of the SEQUENCE, which is the thing being
 * moved.
 */
export interface SessionHistoryPorts<
  Row,
  Attachment,
  ParsedDocument extends { readonly message_id: string },
  Message,
> {
  readonly load: (sessionId: string) => Promise<SessionHistoryLoad<Row, ParsedDocument>>;
  readonly loadAttachments: (
    sessionId: string,
  ) => Map<string, Attachment[]> | Promise<Map<string, Attachment[]>>;
  readonly toMessage: (
    row: Row,
    attachments: Map<string, Attachment[]> | undefined,
    parsedDocuments: Map<string, ParsedDocument[]> | undefined,
  ) => Message;
  readonly validate: (messages: Message[]) => Message[];
  readonly messageId: (message: Message) => string | undefined;
  readonly replace: (
    sessionId: string,
    messages: readonly Message[],
    generation: number,
  ) => Promise<SessionHistoryRepairResult>;
  readonly checkpointIdSuffix: string;
}

/**
 * A restored history.
 *
 * `repairAttempted` is part of the result rather than a log line because the
 * repair is observable to the caller: a history that was rewritten is a
 * different fact from one that was only read.
 */
export interface SessionHistory<Message> {
  readonly rowCount: number;
  readonly messages: Message[];
  readonly repairAttempted: boolean;
  readonly repairResult?: SessionHistoryRepairResult;
}
