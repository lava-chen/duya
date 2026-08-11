/**
 * Mode engine barrel (plan 413a).
 *
 * Exposes the pure state-machine container layer: the {@link ModeTracker}
 * contract, the {@link ModeTrackerEngine} registry, the pure serialization
 * helpers, and the {@link ModeCoordinator} skeleton.
 */

export { ModeTrackerEngine } from './engine.js';
export { ModeCoordinator } from './coordinator.js';
export { serializeSnapshot, snapshotStatus, applySnapshot } from './persistence.js';
export type { ModeTracker, ModeStateSnapshot } from './tracker.js';
