/**
 * @duya/computer-use-demo
 *
 * Local copy of the v0.4 schema types from the external daemon at
 * `E:\Projects\computer-use-demo` (sibling repo). Duplicated here
 * because the daemon is a long-running child process spawned by the
 * Electron main; cross-repo source imports would otherwise pull in
 * the daemon's runtime dependencies (koffi, sharp, nut.js) into the
 * agent bundle.
 *
 * Sync contract:
 *   - Mirrors `E:\Projects\computer-use-demo\src\types.ts` at the
 *     v0.4.0 schema version. When the daemon bumps schemaVersion:
 *       1. Copy the new types.ts from the daemon.
 *       2. Bump `package.json:version` here to match.
 *       3. Update `@duya/agent`'s `ACCEPTED_SCHEMA_VERSIONS` whitelist.
 *
 * Plan 453 Task A (revised — package rather than symlink per user
 * decision 2026-08-28).
 */

export type {
  AppContext,
  AppKind,
  BrowserForm,
  BrowserFormField,
  BrowserFocusedField,
  BrowserPageExtract,
  BrowserSelection,
  BrowserTab,
  CaptureResponse,
  ContextPayload,
  CursorInfo,
  EntityKind,
  FocusInfo,
  FocusedEntity,
  IntentCandidate,
  InteractionEvent,
  MouseTargetInfo,
  MsaaInfo,
  RedactionInfo,
  RedactionReason,
  RGBA,
  ScreenInfo,
  TextInputInfo,
  TrailWindow,
  UiaInfo,
  UiaInput,
  WindowInfo,
} from './types.js';