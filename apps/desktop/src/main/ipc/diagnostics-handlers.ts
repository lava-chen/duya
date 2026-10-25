/**
 * apps/desktop/src/main/ipc/diagnostics-handlers.ts
 *
 * The `diagnostics:run` channel — the Desktop's `/doctor`.
 *
 * ## Why this is an IPC channel and not a renderer-side call
 *
 * The renderer cannot read the disk, and the facts a diagnostic needs (the
 * plugin registry, the core database, the process itself) all live in the
 * main process. `packages/ui/src` is a browser-closure seed, so a renderer
 * that reached for `node:fs` would take the whole browser bundle with it.
 * The report is therefore assembled here and rendered there.
 *
 * ## Trust
 *
 * The handler is read-only and takes no arguments, so the risk surface is
 * small — but the guard is still the FIRST statement, before anything is
 * read from the event, and it fails CLOSED: an untrusted sender gets a
 * rejected promise and the handler body never runs.
 */

import { ipcMain } from 'electron';

import { assertTrustedSender } from './trusted-sender';
import { collectDoctorReport } from './doctor-report';
import { createDesktopDoctorProbe, desktopProfile } from './doctor-facts';

import type { DoctorResult } from '../../contracts/doctor';

/** The channel the renderer invokes. */
export const DIAGNOSTICS_RUN_CHANNEL = 'diagnostics:run';

/**
 * Assemble the report.
 *
 * Split out from the handler so the shape can be exercised without an
 * Electron event. The checks come from the shared diagnostics layer; this
 * function only supplies the Desktop's facts and profile.
 */
export async function collectDesktopDoctorReport(): Promise<DoctorResult> {
  return collectDoctorReport(createDesktopDoctorProbe(), desktopProfile());
}

/** Register the diagnostics channels. */
export function registerDiagnosticsHandlers(): void {
  ipcMain.handle(DIAGNOSTICS_RUN_CHANNEL, async (event) => {
    // Guard first, before anything is read from the event.
    assertTrustedSender(event, {}, DIAGNOSTICS_RUN_CHANNEL);
    return collectDesktopDoctorReport();
  });
}
