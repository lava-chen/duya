/**
 * Mode state-machine engine — flat barrel (plan 413a).
 *
 * Pure state-machine container layer: generic {@link ModeTracker} interface,
 * {@link ModeTrackerEngine} registration container, snapshot serialization
 * pure functions, and the {@link ModeCoordinator} skeleton. No async I/O, no
 * DB / IPC — concrete mode state machines (413b) and persistence wiring
 * (413c) build on top.
 */

export type { AnyModeTracker } from './engine.js';
export { ModeTrackerEngine } from './engine.js';
export type { ModeStateSnapshot, ModeTracker } from './tracker.js';
export {
  applySnapshot,
  serializeSnapshot,
  snapshotStatus,
} from './persistence.js';
export { ModeCoordinator } from './coordinator.js';
