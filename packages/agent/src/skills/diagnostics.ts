/**
 * packages/agent/src/skills/diagnostics.ts
 *
 * Typed skill load diagnostics (mcode parity with `@mavis/skills`'
 * `SkillDiagnostic` — `agent-modules/skills/src/types.ts`).
 *
 * The loader previously reported problems only through scattered
 * `console.warn` calls; failures were invisible to everything downstream
 * (the model, the GUI, tests). Diagnostics give every load problem a
 * stable code + level + location so callers can aggregate, surface, and
 * test them.
 *
 * Model-facing exposure stays deliberately minimal: the skill catalog
 * renders only a count line (no paths, no messages) so third-party text
 * can never leak into the prompt (prompt-injection hardening).
 */

export type SkillDiagnosticLevel = 'error' | 'warning';

/**
 * Stable diagnostic codes. Mirrors mcode's codes where the semantics
 * match (`skill_read_failed`, `skill_file_not_file`,
 * `skill_changed_during_read`, `skill_symlink_rejected`) and adds duya's
 * Agent-Skills spec violations (`name_exceeds_spec`,
 * `description_exceeds_spec`).
 */
export type SkillDiagnosticCode =
  | 'skill_read_failed'
  | 'skill_file_not_file'
  | 'skill_changed_during_read'
  | 'skill_symlink_rejected'
  | 'name_exceeds_spec'
  | 'description_exceeds_spec';

export interface SkillDiagnostic {
  level: SkillDiagnosticLevel;
  code: SkillDiagnosticCode;
  /** Skill directory name, when known. */
  name?: string;
  /** Absolute filesystem location the diagnostic refers to. */
  locationUri: string;
  /** Human-readable detail for logs; never rendered to the model. */
  message: string;
}

/**
 * Hard cap on collected diagnostics per load pass. A pathological skill
 * root (thousands of broken entries) must not grow the array unbounded.
 */
const MAX_DIAGNOSTICS_PER_PASS = 500;

/**
 * Accumulates diagnostics for one skill load pass. Threaded as an
 * optional parameter through the loader chain (no module-global state —
 * concurrent `loadSkills` runs each get their own collector).
 */
export class SkillDiagnosticCollector {
  private items: SkillDiagnostic[] = [];

  collect(diagnostic: SkillDiagnostic): void {
    if (this.items.length >= MAX_DIAGNOSTICS_PER_PASS) return;
    this.items.push(diagnostic);
  }

  /** Take everything collected so far and reset the collector. */
  takeAll(): SkillDiagnostic[] {
    const out = this.items;
    this.items = [];
    return out;
  }

  get size(): number {
    return this.items.length;
  }
}

/** Extract a NodeJS error code string from an unknown error. */
export function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Minimal stat identity used to detect a SKILL.md that changed between
 * two stat observations (mcode `sameSkillFileStat` parity, minus dev/ino
 * which are unreliable across network drives on Windows).
 */
export function sameSkillStat(
  a: { size: number; mtimeMs: number },
  b: { size: number; mtimeMs: number },
): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs;
}
