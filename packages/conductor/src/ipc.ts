/**
 * IPC contract for the conductor <-> main-process bridge.
 *
 * The conductor runs inside the agent subprocess (`@duya/agent`'s
 * `agent-process-entry`). It needs a way to invoke the main process for
 * canvas mutations (create / update / delete / arrange / snapshot) and
 * to push SSE-shaped events back to the renderer.
 *
 * The conductor itself does not own this transport. The host wires up
 * a {@link ConductorIpcBridge} and hands it in via
 * {@link registerConductor} or via the `conductorIpc` field on
 * `ChatOptions` for a single chat turn.
 */

export interface ConductorIpcRequestOptions {
  /** Request timeout in milliseconds. Defaults to 30 000 ms in the host. */
  timeout?: number;
}

export interface ConductorIpcResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

export type ConductorIpcRequest = <T = unknown>(
  action: string,
  payload: unknown,
  options?: ConductorIpcRequestOptions,
) => Promise<ConductorIpcResponse<T>>;

/**
 * Bridge exposed to the conductor. Provided by the host (e.g. the agent
 * subprocess or the standalone CLI) — conductor never instantiates one.
 */
export interface ConductorIpcBridge {
  /** Push an event back to the main process / renderer. */
  sendToMain: (msg: Record<string, unknown>) => void;
  /** Round-trip RPC to the main process. */
  ipcRequest: ConductorIpcRequest;
}
