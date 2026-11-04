/**
 * panel-window-state.ts — persist detached-panel window preferences.
 *
 * The always-on-top flag of a detached panel window is owned by the MAIN
 * process, not by the window that displays it. The reason is lifetime: a
 * detached window can disappear at any moment (the user clicks the native
 * X, which returns the panel to the main window), and a preference that
 * lives only in that window dies with it. The main process outlives every
 * detached window, so it is the only place the flag can be kept.
 *
 * The file lives next to the main window's own state file
 * (`{userData}/window-state.json`) and follows the same rules: a single
 * JSON document, written atomically (tmp + rename) so a crash mid-write
 * cannot corrupt it, and every field validated on read — a malformed file
 * degrades to "no preferences" instead of throwing during startup.
 */

import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getLogger, LogComponent } from '../logging/logger';

/** Preferences the main process keeps for one pane. */
export interface PanelWindowPreference {
  /** Panel page the pane hosts (e.g. `terminal`). */
  pageId: string;
  /** Whether the detached window is pinned above the other windows. */
  alwaysOnTop: boolean;
}

/** Everything persisted about detached panel windows. */
export interface PanelWindowState {
  /** Keyed by pane id. */
  panes: Record<string, PanelWindowPreference>;
}

const STATE_FILE = 'panel-window-state.json';

function getStatePath(): string {
  return path.join(app.getPath('userData'), STATE_FILE);
}

/** A state document with no preferences. */
export function emptyPanelWindowState(): PanelWindowState {
  return { panes: {} };
}

/**
 * Read the persisted preferences.
 *
 * Every field is narrowed from `unknown`: the file is on disk and may have
 * been written by an older build, so its shape cannot be assumed. Anything
 * that does not match the expected shape is dropped rather than trusted.
 */
export function loadPanelWindowState(): PanelWindowState {
  const logger = getLogger();
  try {
    const statePath = getStatePath();
    if (!fs.existsSync(statePath)) return emptyPanelWindowState();

    const parsed: unknown = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      logger.warn('panel-window-state.json has an invalid shape, ignoring', undefined, LogComponent.Main);
      return emptyPanelWindowState();
    }

    const panesRaw = (parsed as { panes?: unknown }).panes;
    if (panesRaw === null || typeof panesRaw !== 'object' || Array.isArray(panesRaw)) {
      return emptyPanelWindowState();
    }

    const panes: Record<string, PanelWindowPreference> = {};
    for (const [paneId, value] of Object.entries(panesRaw as Record<string, unknown>)) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
      const pref = value as { pageId?: unknown; alwaysOnTop?: unknown };
      if (typeof pref.pageId !== 'string') continue;
      panes[paneId] = { pageId: pref.pageId, alwaysOnTop: pref.alwaysOnTop === true };
    }
    return { panes };
  } catch (error) {
    getLogger().error(
      'Failed to load panel window state',
      error instanceof Error ? error : new Error(String(error)),
      undefined,
      LogComponent.Main,
    );
    return emptyPanelWindowState();
  }
}

/**
 * Persist the preferences atomically.
 *
 * Writes a `.tmp` sibling first and renames it over the target, so a
 * partial write never replaces a previously-good document.
 */
export function savePanelWindowState(state: PanelWindowState): void {
  const logger = getLogger();
  try {
    const statePath = getStatePath();
    const tmpPath = `${statePath}.tmp`;
    const dir = path.dirname(statePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(state), 'utf-8');
    fs.renameSync(tmpPath, statePath);
  } catch (error) {
    logger.error(
      'Failed to save panel window state',
      error instanceof Error ? error : new Error(String(error)),
      undefined,
      LogComponent.Main,
    );
  }
}
