/**
 * Tracks commands recently denied by the auto mode classifier.
 * Populated from the permission handler, read from the UI for display.
 */

export type AutoModeDenial = {
  toolName: string;
  display: string;
  reason: string;
  timestamp: number;
};

let DENIALS: readonly AutoModeDenial[] = [];
const MAX_DENIALS = 20;

export function recordAutoModeDenial(denial: AutoModeDenial): void {
  DENIALS = [denial, ...DENIALS.slice(0, MAX_DENIALS - 1)];
}

export function getAutoModeDenials(): readonly AutoModeDenial[] {
  return DENIALS;
}