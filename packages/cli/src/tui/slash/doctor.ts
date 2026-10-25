/**
 * packages/cli/src/tui/slash/doctor.ts
 *
 * `/doctor` — the read-only diagnostic, as a panel.
 *
 * ## What it shows
 *
 * The SAME report `duya doctor` prints, produced by the SAME shared checks
 * (`@duya/host/diagnostics`), grouped by the shared category list. A user who
 * pastes the panel into a bug report and a user who pastes the command output
 * into the same bug report are then describing the same install.
 *
 * ## "This Host cannot answer" is not "the check failed"
 *
 * The panel separates the two, and the separation is visible:
 *
 *  - a group whose checks were all skipped is labelled "(not checked)";
 *  - a skipped row says `[SKIPPED]`, never `[ERROR]`.
 *
 * The CLI is routinely used with no desktop app running — that is the normal
 * case for `duya serve` and for a CLI-only install. Reporting that as an
 * error would train the reader to ignore the errors, and would make a
 * perfectly healthy CLI-only install look broken.
 *
 * ## Why the Host is reached over the Desktop's CLI API
 *
 * The three Host-dependent facts — status, plugin registry, session list —
 * are served by the Desktop's CLI API (`/v1/status`, `/v1/plugins`,
 * `/v1/sessions`), which publishes its address in `runtime/cli-api.json`. The
 * Host API that `ctx.client` speaks serves a different set and has neither
 * `/v1/status` nor `/v1/plugins`, so asking it for them would report a
 * healthy install as broken. The Desktop, which IS a Host, reads those facts
 * in-process instead — through the same shared checks.
 */

import { renderDoctorPanel, runDiagnostics } from '@duya/host/diagnostics';
import type { TuiSlashCommandDef, TuiSlashContext } from './types.js';
import { describeError, showPanel } from './shared.js';
import { resolveDoctorConfigRoot } from '../../commands/doctor-config.js';
import { createDesktopCliApiProbe, resolveRuntimeFact } from '../../commands/doctor-probe.js';

const FOOTER = '↑↓ / PgUp / PgDn scroll · Esc close';

const DOCTOR_COMMAND: TuiSlashCommandDef = {
  name: 'doctor',
  description: 'Diagnose the local Duya install',
  group: 'Session info',
  async run(ctx: TuiSlashContext) {
    // The panel opens straight away: the config half of the diagnostic reads
    // the disk and can take a moment on a slow filesystem, and a command that
    // appears to do nothing is indistinguishable from a command that hung.
    showPanel(ctx, 'Doctor', ['Running diagnostics…'], { footer: FOOTER, scrollable: true });

    try {
      const result = await runDiagnostics({
        configRoot: resolveDoctorConfigRoot(),
        runtime: await resolveRuntimeFact(),
        probe: createDesktopCliApiProbe(),
      });
      showPanel(ctx, 'Doctor', renderDoctorPanel(result), { footer: FOOTER, scrollable: true });
    } catch (error) {
      showPanel(ctx, 'Doctor', [
        'Could not run the diagnostic.',
        '',
        describeError(error),
      ], { footer: FOOTER, scrollable: true });
    }
    return { kind: 'handled' };
  },
};

export const DOCTOR_COMMANDS: readonly TuiSlashCommandDef[] = [DOCTOR_COMMAND];
