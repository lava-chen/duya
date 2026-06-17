/**
 * Type declaration shim for `@duya/conductor`.
 *
 * The agent package uses `@duya/conductor`'s runtime API but the
 * two packages form a build-time cycle: agent's source imports from
 * `@duya/conductor`, and conductor's source imports types from
 * `@duya/agent`. Building either package in isolation against the
 * other's `dist` requires the other to be built first.
 *
 * To break the cycle at the type level, this file declares the
 * narrow subset of the conductor's public surface that the agent
 * references. The declarations are intentionally minimal — they
 * cover only the symbols the agent's source actually uses. If the
 * real conductor's surface drifts, the runtime still works (Node
 * resolves the real module) but TypeScript may miss new properties.
 * The authoritative source of truth for these types lives in
 * `packages/conductor/src/`.
 *
 * This shim is **only** consulted by the agent's tsc. The runtime
 * still loads the real `@duya/conductor` package via dynamic import
 * and (where used) `createRequire`.
 *
 * NOTE: The shapes here are kept loose (`unknown` / `(string & {})`)
 * intentionally so the shim does not need to import the agent's
 * internal types (which would re-introduce the cycle). TypeScript
 * uses the real types when `@duya/conductor/dist/index.d.ts` is
 * available at build time (e.g. for downstream packages).
 */

declare module '@duya/conductor' {
  export interface ConductorSnapshot {
    canvasId: string;
    canvasName: string;
    elements: ConductorElement[];
    widgets?: ConductorWidget[];
    meta?: Record<string, unknown>;
  }

  export interface ConductorElement {
    id: string;
    kind: string;
    position: { x: number; y: number; w: number; h: number };
    config: Record<string, unknown>;
    vizSpec?: Record<string, unknown> | null;
    createdBy?: string;
    createdAt?: number;
    updatedAt?: number;
  }

  export interface ConductorWidget {
    id: string;
    kind: string;
    position: { x: number; y: number };
    size?: { w: number; h: number };
    config?: Record<string, unknown>;
    permissions?: ConductorWidgetPermissions;
  }

  export interface ConductorWidgetPermissions {
    canEdit?: boolean;
    canDelete?: boolean;
    canResize?: boolean;
    canMove?: boolean;
  }

  export interface ConductorCanvasSnapshot {
    canvasId: string;
    canvasName: string;
    elements: Array<{
      id: string;
      kind: string;
      vizSpec?: Record<string, unknown> | null;
      position: { x: number; y: number; w: number; h: number };
      config: Record<string, unknown>;
    }>;
  }

  export type SemanticEventType =
    | 'widget:created'
    | 'widget:updated'
    | 'widget:deleted'
    | 'widget:moved'
    | 'element:clicked'
    | 'canvas:resized'
    | (string & {});

  export interface SemanticEvent {
    type: SemanticEventType;
    timestamp: number;
    payload: Record<string, unknown>;
  }

  export interface PerceptionConfig {
    debounceMs?: number;
    maxEvents?: number;
  }

  export interface ConductorIpcBridge {
    sendToMain: (msg: Record<string, unknown>) => void;
    ipcRequest: <T = unknown>(
      action: string,
      payload: unknown,
      options?: { timeout?: number }
    ) => Promise<{ success: boolean; data?: T; error?: { code: string; message: string } }>;
  }

  export interface ConductorIpcRequest {
    requestId: string;
    action: string;
    payload: unknown;
  }

  export interface ConductorIpcResponse {
    requestId: string;
    success: boolean;
    result?: unknown;
    error?: { code: string; message: string };
  }

  export interface ConductorPromptRegistry {
    registerPromptSystem: (
      name: string,
      factory: (profile?: unknown) => unknown
    ) => void;
    registerOverlayPatch?: (name: string, patch: { enable?: string[]; disable?: string[] }) => void;
  }

  export interface ConductorToolRegistry {
    registerBuiltInTool?: (tool: unknown) => void;
    registerExecutor?: (tool: unknown, executor: unknown) => void;
  }

  export interface ConductorRegistration {
    prompt?: ConductorPromptRegistry;
    tools?: ConductorToolRegistry;
    registerOverlay?: boolean;
  }

  export interface ConductorRegistrationHandle {
    unregister: () => void;
  }

  export const setConductorCanvasState: (snapshot: ConductorCanvasSnapshot | null) => void;
  export const getConductorCanvasSnapshot: () => ConductorCanvasSnapshot | null;
  export const buildConductorCanvasSection: (context: unknown) => string | null;

  export const CANVAS_ORCHESTRATOR_TOOLS: unknown[];
  export const getCanvasOrchestratorExecutors: () => Record<string, unknown>;

  export const VIZ_SPEC_PROMPT: string;
  export const VIZ_SPEC_WORKED_EXAMPLES: string;

  export const CONDUCTOR_PROMPT_PROFILE: { base: 'full'; overlays?: unknown[] };

  export const PerceptionEngine: new (config?: PerceptionConfig) => {
    recordEvent(type: SemanticEventType, payload?: Record<string, unknown>): void;
    drainEvents(): SemanticEvent[];
    formatEventsAsContext(): string;
    reset(): void;
  };

  export const getPerceptionEngine: () => {
    recordEvent(type: SemanticEventType, payload?: Record<string, unknown>): void;
    drainEvents(): SemanticEvent[];
    formatEventsAsContext(): string;
    reset(): void;
  };

  export const resetPerceptionEngine: () => void;

  export const ConductorPromptSystem: new (profile?: unknown) => unknown;

  export const registerConductor: (deps?: ConductorRegistration) => ConductorRegistrationHandle;
}
