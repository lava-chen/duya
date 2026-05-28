/**
 * Auto mode state tracking for duya Agent.
 *
 * Tracks whether auto mode is currently active and whether
 * the classifier circuit is broken (should fall back to prompting).
 */

let autoModeActive = false;
let autoModeCircuitBroken = false;

export function setAutoModeActive(active: boolean): void {
  autoModeActive = active;
}

export function isAutoModeActive(): boolean {
  return autoModeActive;
}

export function setAutoModeCircuitBroken(broken: boolean): void {
  autoModeCircuitBroken = broken;
}

export function isAutoModeCircuitBroken(): boolean {
  return autoModeCircuitBroken;
}