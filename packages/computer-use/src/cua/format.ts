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
  if (el.selected) score += 240;
  if (el.pressable && el.enabled) score += 200;
  if (leafControl) score += 100;
  if (el.title) score += 60;
  if (el.label) score += 40;
  if (el.editable && !container) score += 120;
  if (el.hasMenu && !container) score += 30;
  if (el.value) score += 20;
  if (container) score -= 120;
  if (el.offscreen) score -= 150;
  const [, , ew, eh] = el.bounds;
  const [, , ww, wh] = windowBounds ?? [0, 0, 0, 0];
  if (ew <= 0 || eh <= 0) {
    score -= kind === 'menuitem' ? 50 : 400;
  }
  if (ww > 0 && wh > 0 && ew * eh >= ww * wh * 0.75) score -= 80;
  return score;
}

/** Value/label display cap on one row (ZCode row shape). */
const ROW_VALUE_CAP = 60;
const ROW_LABEL_CAP = 40;

/** Actions every element effectively has — not worth a row slot (ZCode). */
const UBIQUITOUS_ACTIONS: ReadonlySet<string> = new Set(['AXScrollToVisible']);

function rowTruncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/** One element row (ZCode row shape: indent = depth, caps in parens). */
export function elementRow(index: number, el: CuaElement): string {
  const caps: string[] = [];
  if (el.pressable) caps.push('pressable');
  if (el.editable) caps.push('editable');
  if (el.hasMenu) caps.push('has_menu');
  if (el.focused) caps.push('focused');
  if (el.selected === true) caps.push('selected');
  if (el.checked === true) caps.push('checked');
  if (el.checked === false) caps.push('unchecked');
  if (el.enabled === false) caps.push('disabled');
  if (el.offscreen === true) caps.push('offscreen');
  // Identity: the element's own name first; an otherwise-unlabeled field
  // falls back to the absorbed static-text label (plan 576). `||` (not
  // ??) on purpose: an EMPTY-string name must fall through too.
  const titleText = el.title || el.label || null;
  const title = titleText ? ` ${titleText}` : '';
  const labelSuffix =
    el.title && el.label ? ` label:"${rowTruncate(el.label, ROW_LABEL_CAP)}"` : '';
  const value = el.value ? ` = ${rowTruncate(el.value, ROW_VALUE_CAP)}` : '';
  const head = `[${index}] ${el.kind || el.role.toLowerCase() || 'unknown'}${title}${labelSuffix}${value}`;
  const tail = caps.length > 0 ? ` (${caps.join(' ')})` : '';
  const semanticActions = el.actions.filter((a) => !UBIQUITOUS_ACTIONS.has(a));
  const actions =
    semanticActions.length > 0 ? ` actions=[${semanticActions.join(',')}]` : '';
  // Hierarchy: the probe's real tree depth (plan 576), indented like the
  // ZCode row renderer (capped so a deep DOM chain cannot push the row
  // body off-screen).
  const indent = ' '.repeat(1 + Math.min(el.depth ?? 0, 24));
  return `${indent}${head}${tail}${actions}`;
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
    // Keep ancestors: ZCode's depth walk-back — from each kept element,
    // fill the missing parent chain by scanning backwards for the next
    // element at depth-1, depth-2, … until the root. The probe's real
    // tree depth (plan 576) makes this exact; without depth fields
    // (older probe) every depth reads 0 and the walk is a no-op.
    for (const { index } of selected) {
      let wanted = (obs.elements[index]?.depth ?? 0) - 1;
      for (let j = index - 1; j >= 0 && wanted >= 0; j -= 1) {
        if ((obs.elements[j]?.depth ?? 0) === wanted) {
          keep.add(j);
          wanted -= 1;
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
