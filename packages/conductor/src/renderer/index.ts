/**
 * @duya/conductor/renderer — renderer-side module
 *
 * Re-exports the public surface of the conductor renderer module:
 * the React components, the canvas orchestration stores, the
 * Element/Widget registries, the refine subsystem, and the IPC
 * bridge used by the renderer to talk to the agent subprocess and
 * the Electron main process.
 *
 * The renderer module is consumed exclusively by the Vite-built
 * renderer. It never runs in the agent subprocess — that side uses
 * the package's main entry (`@duya/conductor`), which exposes the
 * server-side prompt/tool/perception system.
 *
 * Cross-boundary dependencies (provider listing, agent LLM calls)
 * are supplied by the host application through
 * `<ConductorHostProvider host={...}>`. The host must be mounted
 * before any conductor code reads providers or invokes the agent.
 */
export {
  ConductorHostContext,
  useConductorHost,
  getConductorHostOrNull,
  setConductorHostScope,
} from "./host";
export type {
  ConductorHost,
  ConductorAgent,
  ConductorProvider,
  ConductorModelInfo,
  ModelOption,
} from "./host";

