/**
 * AgentRuntime — Plan 550 step 2a-2.
 *
 * Structural interface the `TurnAssembler` reads from. Implemented
 * by `duyaAgent` (the wiring commit will add the implementation
 * methods or wire the existing private fields through getters).
 *
 * The interface is intentionally narrow — only the fields the
 * assembler needs to populate a `TurnContext`. New read sites should
 * extend this interface rather than reaching back into the god
 * class.
 *
 * @see docs/exec-plans/active/550-prompt-hbs-and-agent-decomposition.md
 */

import type { CommunicationPlatform } from '../prompts/types.js';
import type { LocalToolPermission, PermissionMode } from '../permissions/types.js';

/**
 * Structural read-only view of `duyaAgent` that the `TurnAssembler`
 * (and eventually the rest of the loop body) consumes. Methods
 * return `undefined` for optional fields so the assembler can spread
 * them into `TurnContextShape` without conditional clauses scattered
 * across the build path.
 */
export interface AgentRuntime {
  /** Per-session monotonically-increasing turn sequence. */
  turnSequence(): number;
  /** Session id used in journal + SSE events. */
  sessionId(): string | undefined;
  /** Workspace directory for tool execution. */
  workingDirectory(): string | undefined;
  /** Communication platform (CLI, IM, ...) when one is configured. */
  communicationPlatform(): CommunicationPlatform | undefined;
  /** User-preferred response language. */
  language(): string | undefined;
  /** Permission mode for tool execution. */
  permissionMode(): PermissionMode;
  /** Per-tool local permission overrides when configured. */
  hostToolPermission(): LocalToolPermission | undefined;
  /** Additional working directories permitted for tool use. */
  additionalWorkingDirectories(): ReadonlyMap<string, unknown>;
  /** Per-turn always-allow tool names (reset by every `streamChat`). */
  turnAlwaysAllowTools(): readonly string[];
}