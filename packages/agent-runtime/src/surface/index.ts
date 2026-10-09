/**
 * The surface layer: a renderer-independent view of a run.
 *
 * ## What belongs here
 *
 * Anything that answers "what should a UI show", derived from `RunEventEnvelope`
 * and never from the legacy frame vocabulary. `legacy-projection.ts` is the one
 * exception in spirit — it is the DOWN direction, kept so the desktop renderer
 * is unaffected by this layer existing.
 *
 * ## What does not belong here
 *
 * Anything that draws. There is no blessed import, no ANSI, no cursor, and no
 * row height in this directory, and that is a load-bearing constraint rather
 * than tidiness: the conformance suite runs against the model with no renderer
 * present, which is the only reason a second renderer can be added later without
 * the two drifting.
 */

export { SurfaceModel } from './surface-model.js';
export type {
  CheckpointSurface,
  CompactionPhase,
  CompactionSurface,
  DiagnosticSurface,
  ExtensionSurface,
  HookSurface,
  MessageSurface,
  PermissionPhase,
  PermissionSurface,
  RunStatus,
  RunSurface,
  SubagentPhase,
  SubagentSurface,
  SurfaceEffect,
  ToolCallSurface,
  ToolGroupSurface,
  ToolPhase,
  ToolProgressSurface,
  TurnPhase,
  TurnRetrySurface,
  TurnSurface,
} from './surface-model.js';

export {
  LEGACY_MAPPED_EVENT_TYPES,
  LEGACY_UNMAPPED_EVENT_TYPES,
  isLegacyMapped,
  replayOntoSurface,
} from './legacy-projection.js';
export type { SurfaceReplay } from './legacy-projection.js';
