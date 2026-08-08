/**
 * model.ts - ModelRuntime
 *
 * Mutable handle for the current model id and thinking level (Plan 334 Phase 5).
 * This is the hot-swap surface for `prepareNextTurn`: the agent-loop reads the
 * current model / thinking level from here each turn and may swap them mid-run
 * without reconstructing the agent. The underlying fields mirror the mutable
 * `model` / `thinkingLevel` properties previously held directly on `DuyaAgent`.
 */

import type { ThinkingLevel } from '@duya/ai';

/** Immutable snapshot of the current model runtime state. */
export interface ModelRuntimeSnapshot {
  readonly model: string;
  readonly thinkingLevel: ThinkingLevel;
}

/**
 * Runtime handle for the active model id and thinking level.
 */
export class ModelRuntime {
  private modelId: string;
  private thinking: ThinkingLevel;

  constructor(model: string, thinkingLevel: ThinkingLevel = 'medium') {
    this.modelId = model;
    this.thinking = thinkingLevel;
  }

  /** Swap the active model id. */
  setModel(model: string): void {
    this.modelId = model;
  }

  /** The active model id. */
  getModel(): string {
    return this.modelId;
  }

  /** Swap the thinking level (mapped to the provider's native effort). */
  setThinkingLevel(level: ThinkingLevel): void {
    this.thinking = level;
  }

  /** The current thinking level. */
  getThinkingLevel(): ThinkingLevel {
    return this.thinking;
  }

  /** Immutable snapshot of the current model + thinking level. */
  snapshot(): ModelRuntimeSnapshot {
    return { model: this.modelId, thinkingLevel: this.thinking };
  }
}