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
  CaptureOptions,
  CaptureResult,
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
} from './electron/factory.js';