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
 *
 * Method names are prefixed with `read` to avoid colliding with the
 * existing `duyaAgent` private fields of the same logical name
 * (`sessionId`, `workingDirectory`, `language`, `permissionMode`,
 * `hostToolPermission`, `communicationPlatform`,
 * `additionalWorkingDirectories`, `_turnAlwaysAllowTools`). A field
 * and a method with the same name are different symbols in TS, but
 * the interface-vs-class structural check needs the method to be
 * unambiguously declared.
 */
export interface AgentRuntime {
  /** Per-session monotonically-increasing turn sequence. */
  readTurnSequence(): number;
  /** Session id used in journal + SSE events. */
  readSessionId(): string | undefined;
  /** Workspace directory for tool execution. */
  readWorkingDirectory(): string | undefined;
  /** Communication platform (CLI, IM, ...) when one is configured. */
  readCommunicationPlatform(): CommunicationPlatform | undefined;
  /** User-preferred response language. */
  readLanguage(): string | undefined;
  /** Permission mode for tool execution. */
  readPermissionMode(): PermissionMode;
  /** Per-tool local permission overrides when configured. */
  readHostToolPermission(): LocalToolPermission | undefined;
  /** Additional working directories permitted for tool use. */
  readAdditionalWorkingDirectories(): ReadonlyMap<string, unknown>;
  /** Per-turn always-allow tool names (reset by every `streamChat`). */
  readTurnAlwaysAllowTools(): readonly string[];
}