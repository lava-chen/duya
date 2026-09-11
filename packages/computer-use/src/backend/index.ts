/**
 * backend/index.ts — barrel (plan 454 §5 Task B).
 *
 * Re-exports the platform-agnostic DesktopBackend interface plus the
 * two shipped impls (Noop + Electron). Higher-level code (e.g. the
 * agent's OSTool layer in Phase 2) imports from here.
 */

export type {
  ActionResult,
  AppInfo,
  Bbox,
  CaptureOptions,
  CaptureResult,
  ClickCount,
  ClickOptions,
  DesktopBackend,
  DragOptions,
  FocusAppOptions,
  KeyOptions,
  MouseButton,
  ScrollDirection,
  ScrollOptions,
  SetValueOptions,
  SomElement,
  TypeTextOptions,
} from './types.js';

export {
  NoopDesktopBackend,
  type NoopDesktopBackendOptions,
  type RecordedAction,
} from './stub.js';

export {
  ElectronDesktopBackend,
  createElectronDesktopBackend,
  type ElectronDesktopBackendOptions,
  type ElectronAdapter,
  type NutAdapter,
  type SharpAdapter,
  type SharpPipeline,
} from './electron/index.js';

export {
  getDefaultDesktopBackend,
  setDefaultDesktopBackend,
  __resetDefaultDesktopBackend,
  getOrCreateNoopBackend,
  buildPlatformDefault,
  shouldUseMcpDriver,
  resolveCuaDriverCommand,
} from './electron/factory.js';

export {
  McpCuaDriverBackend,
  CUA_TOOL_NAME,
  type McpCuaDriverOptions,
  type CallTool,
} from './mcp/cua-driver.js';

export {
  parseCaptureResult,
  parseActionResult,
  parseListApps,
} from './mcp/result-parser.js';