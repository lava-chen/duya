/**
 * cua/format.ts — LLM-facing observation text.
 *
 * Port of the ZCode/Codex `formatAppStateTree` (plan 575): header lines,
 * priority-based element trimming with ancestors kept, sparse-index
 * annotation, and the per-element row shape
 * `[i] kind title = value (focused) (pressable) (has_menu) actions=[...]`.
 * The priority scoring table is verbatim (plan 575 §2).
 */

import { uiaControlTypeToKind } from './kindMap.js';
import type { CuaElement, CuaObservation } from './types.js';

/** Default model-visible element cap (ZCode: 1500, env-tunable there). */
export const DEFAULT_MAX_ELEMENTS = 1500;

/** Priority score deciding which elements survive trimming. */
export function elementPriority(
  el: CuaElement,
  windowBounds: [number, number, number, number] | null,
): number {
  let score = 0;
  const kind = (el.kind ?? '').toLowerCase();
  const container = /group|split|scroll|layout|container|pane|unknown/.test(kind);
  const leafControl = /button|check|radio|switch|link|menuitem|tab|textfield|textarea|slider/.test(
    kind,
  );
  if (el.focused) score += 220;
  if (el.pressable && el.enabled) score += 200;
  if (leafControl) score += 100;
  if (el.title) score += 60;
  if (el.editable && !container) score += 120;
  if (el.hasMenu && !container) score += 30;
  if (el.value) score += 20;
  if (container) score -= 120;
  const [, , ew, eh] = el.bounds;
  const [, , ww, wh] = windowBounds ?? [0, 0, 0, 0];
  if (ew <= 0 || eh <= 0) {
    score -= kind === 'menuitem' ? 50 : 400;
  }
  if (ww > 0 && wh > 0 && ew * eh >= ww * wh * 0.75) score -= 80;
  return score;
}

/** One element row (aligned row shape; title first, metadata after). */
export function elementRow(index: number, el: CuaElement): string {
  const parts: string[] = [`[${index}]`];
  parts.push(el.kind || el.role.toLowerCase() || 'unknown');
  if (el.title) parts.push(el.title);
  if (el.value) parts.push(`= ${el.value}`);
  if (el.focused) parts.push('(focused)');
  if (el.pressable) parts.push('(pressable)');
  if (el.hasMenu) parts.push('(has_menu)');
  if (!el.enabled) parts.push('(disabled)');
  if (el.actions.length > 0) parts.push(`actions=[${el.actions.join(',')}]`);
  return parts.join(' ');
}

/**
 * Render the observation receipt as model-facing text. `maxElements`
 * trims by priority with ancestors kept; when trimmed, indices are
 * sparse and the note says so (the model must re-observe rather than
 * guess hidden indices).
 */
export function formatObservation(
  obs: CuaObservation,
  opts: { maxElements?: number } = {},
): string {
  const maxElements = opts.maxElements ?? DEFAULT_MAX_ELEMENTS;
  const appParts: string[] = [];
  if (obs.app.bundleId) appParts.push(obs.app.bundleId);
  appParts.push(`pid=${obs.app.pid}`);
  if (obs.app.name) appParts.push(`"${obs.app.name}"`);

  const [wx, wy, ww, wh] = obs.window.bounds ?? [0, 0, 0, 0];
  const title = obs.window.title ? ` "${obs.window.title}"` : '';
  const windowLine = `window:${title} window_id=${obs.window.windowId} bounds=[${wx},${wy},${ww},${wh}]`;

  let entries = obs.elements.map((el, index) => ({ el, index }));
  let truncatedCount = 0;
  if (entries.length > maxElements) {
    const ranked = entries.map(({ el, index }) => ({ el, index, score: elementPriority(el, obs.window.bounds) }));
    ranked.sort((a, b) => b.score - a.score);
    const selected = ranked.slice(0, maxElements);
    const keep = new Set(selected.map((entry) => entry.index));
    // Keep ancestors: walk back up filling the missing depth chain. The
    // flat duya list has no depth yet, so "ancestors" = the preceding
    // structural containers by bounds containment (cheap, deterministic).
    for (const { index } of selected) {
      const box = obs.elements[index]?.bounds;
      if (!box) continue;
      for (let j = index - 1; j >= 0; j -= 1) {
        const outer = obs.elements[j]?.bounds;
        if (!outer) continue;
        const contains =
          outer[0] <= box[0] &&
          outer[1] <= box[1] &&
          outer[0] + outer[2] >= box[0] + box[2] &&
          outer[1] + outer[3] >= box[1] + box[3];
        if (contains && !keep.has(j)) {
          keep.add(j);
        }
      }
    }
    entries = [...keep]
      .sort((a, b) => a - b)
      .flatMap((index) => {
        const el = obs.elements[index];
        return el ? [{ el, index }] : [];
      });
    truncatedCount = obs.elements.length - entries.length;
  }

  const rows = entries.map(({ el, index }) => elementRow(index, el));
  const truncatedNote =
    truncatedCount > 0
      ? `note: ${entries.length} of ${obs.elements.length} elements shown (selected by priority, ancestors kept) — indices are sparse; ${truncatedCount} hidden`
      : '';

  return [
    `app: ${appParts.join(' ')}`,
    windowLine,
    truncatedNote,
    `elements (${entries.length}${truncatedCount > 0 ? ` of ${obs.elements.length}` : ''}):`,
    ...rows,
  ]
    .filter((line) => line.length > 0)
    .join('\n');
}

/** Render a snapshot diff as the delta advisory block. */
export function formatDiff(obs: CuaObservation): string {
  const diff = obs.changes;
  if (!diff) return '';
  // Same vocabulary as the tree rows: kind first, raw role as fallback.
  const label = (role: string) => uiaControlTypeToKind(role) || role.toLowerCase() || 'unknown';
  const lines: string[] = [];
  if (diff.addedCount > 0) {
    for (const a of diff.added) {
      lines.push(`+ [${a.index}] ${label(a.role)} ${a.title ?? ''}`.trimEnd());
    }
    if (diff.addedCount > diff.added.length) {
      lines.push(`+ ... and ${diff.addedCount - diff.added.length} more added`);
    }
  }
  for (const u of diff.updated) {
    const fields = Object.keys(u.changes).join(',');
    lines.push(`~ [${u.index}] ${label(u.role)} ${u.title ?? ''} (${fields})`.trimEnd());
  }
  if (diff.removedCount > 0) {
    for (const r of diff.removed) {
      lines.push(`- ${label(r.role)} ${r.title ?? ''}`.trimEnd());
    }
    if (diff.removedCount > diff.removed.length) {
      lines.push(`- ... and ${diff.removedCount - diff.removed.length} more removed`);
    }
  }
  if (diff.focusChanged) {
    lines.push(`focus: ${diff.focusedTitle ?? '(none)'}`);
  }
  return lines.join('\n');
}
