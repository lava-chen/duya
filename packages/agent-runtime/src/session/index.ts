/**
 * `@duya/agent-runtime/session` — the Runtime Session service.
 *
 * ## Why a subpath and not the main entry
 *
 * The package's other independent surfaces follow the same rule: `./tools/catalog`,
 * `./context/compact`, `./turns/*`. An import that names its surface says what
 * it depends on, and a consumer that reaches for the whole package when it
 * only needs the session service has acquired a dependency on the engine, the
 * tool registry and everything they pull in.
 *
 * It is also a boundary marker. Everything under `session/` is free of Host,
 * data, model and Electron imports, and the architecture gate can see that
 * because the subpath resolves to a single directory.
 */

/**
 * The workspace reference a session operates in.
 *
 * Opaque identifiers and a path relative to the workspace root — never a
 * resolved filesystem path. The shape cannot express `..`, so a session
 * cannot address a directory outside its workspace.
 */
export type {
  SessionWorkspace,
  SessionRunRequest,
  SessionRunIdentity,
  SessionAdmissionOutcome,
  SessionAdmissionPort,
  SessionExecutionPort,
  SessionHistoryLoad,
  SessionHistoryRepairResult,
  SessionHistoryPorts,
  SessionHistory,
} from './ports.js';

export { hydrateSessionHistory } from './history.js';

export {
  createRuntimeSessionService,
  SessionExecutionUnavailableError,
} from './service.js';
export type {
  RuntimeSessionService,
  RuntimeSessionServicePorts,
} from './service.js';
