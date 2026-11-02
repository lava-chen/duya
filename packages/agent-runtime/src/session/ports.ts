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
 * opaque workspace id, a root id, and a path RELATIVE to that root. The
 * relative path is a checked type — `toSessionRelativePath` refuses anything
 * that leaves the root — so a session cannot address a directory outside its
 * own workspace, and the check is a property of the value rather than a
 * promise in a comment. See `SessionWorkspace` for the reasoning.
 */

/**
 * Where a session operates.
 *
 * Mirrors the `bound` arm of the Host's workspace binding on purpose: two
 * shapes for one fact drift, and the Host's shape is the one already on the
 * wire. It carries identifiers, never a resolved filesystem path — the Host
 * resolves those, and a runtime that knew them would be one refactor away
 * from leaking them into a prompt or an event.
 *
 * ## The path is NOT just a string
 *
 * `relativePath` used to be typed `string`, while this file claimed the path
 * "cannot express `..`" so a session could not address a directory outside its
 * workspace. A plain string expresses `..` perfectly well, so the claim was
 * decoration: the type did not prevent the escape, it only described the
 * intent.
 *
 * It is now a BRANDED type that can only be produced by
 * `toSessionRelativePath()`, which rejects anything that leaves the root. The
 * brand stops a raw string from being passed where a checked path is
 * expected; the validator is what actually stops the escape. Both are needed:
 * the brand is the compile-time half, the validator is the runtime half, and
 * neither substitutes for the other.
 */
export interface SessionWorkspace {
  readonly workspaceId: string;
  readonly rootId: string | null;
  readonly relativePath: SessionRelativePath;
}

const SESSION_RELATIVE_PATH_BRAND: unique symbol = Symbol('duya.sessionRelativePath');

/**
 * A path relative to a workspace root that provably stays inside it.
 *
 * Produce one with `toSessionRelativePath`. The empty string is the root
 * itself and is valid.
 */
export type SessionRelativePath = string & {
  readonly [SESSION_RELATIVE_PATH_BRAND]: true;
};

/**
 * Why a relative path was refused.
 *
 * The reasons are separate because they are separate failures: an absolute
 * path is a caller that passed a resolved filesystem path where a workspace
 * reference was expected, a parent segment is an escape attempt, and a
 * control character is an injection. Merging them into one "invalid path"
 * would lose the distinction between a bug and an attack.
 */
export type SessionRelativePathRejection =
  | 'absolute_path'
  | 'parent_segment'
  | 'control_character';

/**
 * Split a path into segments, tolerating both separators.
 *
 * Windows accepts both, so a path that looks safe with one separator must not
 * become unsafe with the other.
 */
function pathSegments(raw: string): string[] {
  return raw.split(/[\\/]+/).filter((segment) => segment.length > 0);
}

/**
 * Windows strips trailing dots and spaces from a path segment before it
 * touches the filesystem.
 *
 * That makes `".. "` — two dots and a space — resolve as the parent
 * directory, and `".. ."` as well. `"..."` collapses to an empty name, which
 * is not a usable directory either.
 *
 * So a segment made ONLY of dots and spaces is refused, whatever it reduces
 * to. `"."` is the exception: it is the current directory and stays inside
 * the root.
 */
function isParentSegment(segment: string): boolean {
  const withoutTrailingDotsAndSpaces = segment.replace(/[ .]+$/, '');
  if (withoutTrailingDotsAndSpaces !== '') {
    // A normal name. Windows may shorten it ("a.." is "a"), but shortening
    // cannot leave the root.
    return false;
  }
  // Only dots and spaces are left. "." is the current directory; anything
  // with two or more dots is a parent or an unusable name.
  return segment.replace(/ /g, '').length >= 2;
}

/**
 * Check a path without throwing.
 *
 * Returns the reason it would be refused, or `null` when the path is safe.
 */
export function sessionRelativePathRejection(raw: string): SessionRelativePathRejection | null {
  for (const character of raw) {
    // The point is to REJECT control characters: a NUL truncates a path at the
    // syscall boundary on some platforms, and a newline in a path breaks every
    // log line that prints it.
    if (character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f) {
      return 'control_character';
    }
  }

  // An absolute path, a Windows drive prefix, or a UNC share. All three
  // name a location OUTSIDE the workspace root, which is exactly what a
  // relative reference must never do.
  if (raw.startsWith('/') || raw.startsWith('\\')) {
    return 'absolute_path';
  }
  if (/^[A-Za-z]:/.test(raw)) {
    return 'absolute_path';
  }

  for (const segment of pathSegments(raw)) {
    if (isParentSegment(segment)) {
      return 'parent_segment';
    }
  }

  return null;
}

/**
 * Check whether a path stays inside its workspace root.
 */
export function isSessionRelativePathSafe(raw: string): boolean {
  return sessionRelativePathRejection(raw) === null;
}

/**
 * Turn a raw path into a checked workspace-relative path.
 *
 * @throws when the path is absolute, contains a parent segment, or carries a
 *   control character. A caller that cannot produce a safe path has a bug or
 *   an attack, and both deserve a loud failure rather than a sanitised path
 *   that quietly points somewhere else.
 */
export function toSessionRelativePath(raw: string): SessionRelativePath {
  const rejection = sessionRelativePathRejection(raw);
  if (rejection !== null) {
    throw new Error(
      `session workspace: refusing a relative path (${rejection}): ${JSON.stringify(raw)}`,
    );
  }
  return raw as SessionRelativePath;
}

/**
 * What the caller asked the session to do.
 *
 * This is an INPUT, and it stays an input. It deliberately carries no
 * manifest, no run identity and no configuration: those are the Host's to
 * freeze. A request that carried them would be a second authority — the Host
 * would have to either trust the caller's frozen configuration or reject it,
 * and rejecting it would mean the Host had two ways to produce a manifest.
 *
 * ## It is the DEFAULT shape, not the only one
 *
 * A port that answered with this shape would force every Host to fit its
 * turn into six fields, and the fields a Host needs to freeze a manifest are
 * NOT these six: the Host has already resolved the session's defaults, the
 * permission ceiling and the turn overrides by the time it asks for
 * admission, and it needs to hand those forward.
 *
 * So the admission port is generic over its request type, and this shape is
 * the default for a Host that has nothing extra to say. The Runtime does not
 * read the request: it forwards it. That is what lets the same service serve
 * a Host that sends a prompt and a Host that sends a fully resolved turn
 * without the Runtime knowing which is which.
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
 * WHICH situation stopped an admission.
 *
 * The three states below say whether a retry is meaningful; this says WHICH
 * thing happened. Both are needed, and they are not redundant: `rejected`
 * covers four different situations whose next steps differ, and a caller that
 * only learns "rejected" has to guess whether to wait, to reconcile against a
 * receipt, or to tell the user their request was wrong.
 *
 * R1.0 found the Host collapsing five internal failure modes into one wire
 * stage, and that the collapsed bucket mixed "the session is busy" (wait),
 * "this exact run already exists" (reconcile against the receipt) and "the
 * run row was never written" (retry, and alert). This vocabulary is the
 * un-collapsed form.
 *
 * ## It is the port's own vocabulary
 *
 * The Runtime owns these names because the Runtime owns the port. The Host
 * maps its internal stages onto them at the adapter boundary, so a Host-side
 * refactor does not become a Runtime change, and the Host's own stage names
 * stay where they are — the Control Plane's, not the session service's.
 */
export type SessionAdmissionStage =
  /**
   * The session does not exist in the Host's stores.
   *
   * The request named something that is not there. Nothing about the moment
   * changes the answer.
   */
  | 'no_session'
  /**
   * The request named a value the Host will not run — an invalid permission
   * mode, a malformed option, an unknown profile.
   *
   * A bug in the caller's request, not a state of the world.
   */
  | 'invalid_input'
  /**
   * Another run owns this session.
   *
   * The caller WAITS. The session's state is the reason, so the refusal is a
   * property of the session rather than of the attempt.
   */
  | 'session_busy'
  /**
   * The Control Plane reports this run id already records the same manifest
   * and input.
   *
   * The row exists and is CORRECT. What is refused is a SECOND execution
   * against it, so the caller's next step is to reconcile against the
   * receipt — not to retry, and not to report an error.
   */
  | 'run_already_exists'
  /**
   * The Control Plane would not create the run row.
   *
   * A durability problem: the run has no durable record. Retrying is
   * meaningful, and an operator should be told.
   */
  | 'run_not_created'
  /**
   * The row exists but `run.started` never landed.
   *
   * A transient storage problem. The run is half-recorded and the caller
   * cannot tell from the row alone whether it is live.
   */
  | 'not_durable'
  /**
   * The executor was not there — no worker, closed pipe.
   *
   * Retrying after one spawns is the fix.
   */
  | 'dispatch_refused'
  /**
   * The dispatch itself threw.
   *
   * A Host bug rather than a state of the world.
   */
  | 'dispatch_failed'
  /**
   * The Host's own plumbing failed before any of the above could be
   * attributed.
   */
  | 'unknown';

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
 *
 * `stage` narrows each state to the situation that caused it, so the caller
 * can act on the difference without parsing the reason string.
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
  | {
      readonly state: 'rejected';
      readonly stage: SessionAdmissionStage;
      readonly reason: string;
      /**
       * The run id, when the refusal NAMED one.
       *
       * `run_already_exists` is the case that needs it: the run is recorded
       * and correct, and the caller's next step is to reconcile against that
       * receipt rather than start a second run. A refusal that minted an id
       * and then abandoned it has no id to report, so this is optional rather
       * than always null.
       */
      readonly runId?: string;
    }
  /**
   * The Host could not be reached, or answered something unusable.
   *
   * Retrying is meaningful here, and the distinction from `rejected` is the
   * whole reason this port has three states.
   */
  | {
      readonly state: 'failed';
      readonly stage: SessionAdmissionStage;
      readonly reason: string;
      /** The run id, when the failure NAMED one. See `rejected`. */
      readonly runId?: string;
    };

/**
 * How a session asks the Host to start a run.
 *
 * The Host implementation calls the control plane's atomic operations
 * directly. It must NOT call a public start entry that forwards back into
 * this service: that is a recursion, and it is the failure mode the R1 plan
 * names explicitly. The direction is one-way — the Runtime asks, the Host
 * decides.
 *
 * ## Why it is generic over its request
 *
 * The Runtime never reads the request; it forwards it. So the port does not
 * have to insist on one shape, and a Host that has already resolved the
 * session's defaults and the turn's permission ceiling can hand those
 * forward instead of re-deriving them from a prompt.
 *
 * The default is {@link SessionRunRequest}, which is what a Host with nothing
 * extra to say sends.
 */
export interface SessionAdmissionPort<Request = SessionRunRequest> {
  admit(request: Request): Promise<SessionAdmissionOutcome>;
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
