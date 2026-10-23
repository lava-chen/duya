/**
 * packages/cli/src/tui/slash/pr.ts
 *
 * `/pr` — the pull requests this session is associated with, as the Host last
 * observed them (plan 621 §4.4, Integration row).
 *
 * ## Reading is projection-only; refreshing is the explicit network action
 *
 * The projection read (`GET /v1/integrations`) never contacts the hosting
 * service: it returns what the Host stored the last time it looked. Only
 * `/pr refresh` (`POST /v1/integrations/sync`) asks the Host to look again.
 * Keeping the two apart is what makes the command safe to type at any time —
 * a plain `/pr` cannot make a network call happen behind the user's back.
 *
 * ## `unknown` is rendered as `unknown`
 *
 * An observation can fail: no `gh`, no network, no token, a rate limit. The
 * contract makes `unknown` a first-class state and requires the reason to
 * travel with it, because "we could not look" and "the pull request is
 * merged" are different facts. This panel therefore prints the state exactly
 * as the Host reported it and prints the reason beside it. It is never
 * folded into `open`.
 *
 * ## Every row is stamped with when it was observed
 *
 * `observedAt` says when the value was read from the hosting service. A row
 * without that stamp would read as a current fact; it is a reading.
 */

import type { HostIntegrationRecord, HostIntegrationSyncResult } from '@duya/agent-protocol';
import type { TuiSlashCommandDef, TuiSlashContext } from './types.js';
import { describeError, hostErrorCode, showPanel } from './shared.js';

const FOOTER = '↑↓ / PgUp / PgDn scroll · Esc close';

/** The state exactly as the Host reported it — never rewritten. */
function stateLine(record: HostIntegrationRecord): string {
  return record.state;
}

/**
 * The reason an observation failed, printed on its own line.
 *
 * Only `unknown` carries one. A successful observation has `observedError`
 * set to null, and printing an empty reason there would be noise.
 */
function reasonLine(record: HostIntegrationRecord): string | null {
  if (record.state !== 'unknown') return null;
  return record.observedError ?? 'no reason reported';
}

function recordLines(record: HostIntegrationRecord): string[] {
  const lines = [
    `  ${record.repo}#${record.prNumber}  ${stateLine(record)}`,
    `      url       ${record.url ?? '(not observed)'}`,
    `      observed  as of ${new Date(record.observedAt).toLocaleString()}`,
  ];
  const reason = reasonLine(record);
  if (reason !== null) lines.push(`      reason    ${reason}`);
  return lines;
}

function prLines(records: readonly HostIntegrationRecord[]): string[] {
  if (records.length === 0) {
    return [
      '  No pull request is associated with this session yet.',
      '',
      '  Source: Host integration projection (GET /v1/integrations), read-only.',
    ];
  }
  const lines: string[] = [];
  for (const record of records) lines.push(...recordLines(record));
  lines.push('');
  lines.push('  Source: Host integration projection (GET /v1/integrations), read-only.');
  lines.push('  Run /pr refresh to re-read the pull requests from the hosting service.');
  return lines;
}

/** The outcome of one explicit refresh, printed before the fresh projection. */
function syncLines(result: HostIntegrationSyncResult): string[] {
  const lines = [`  refresh  ${result.status}`];
  for (const written of result.written) {
    lines.push(`    wrote   ${written.repo}#${written.prNumber}`);
  }
  for (const failure of result.failed) {
    lines.push(`    failed  ${failure.ref} — ${failure.reason}`);
  }
  return lines;
}

const PR_COMMAND: TuiSlashCommandDef = {
  name: 'pr',
  argsHint: '[refresh]',
  description: 'Show the pull requests associated with this session',
  group: 'Session info',
  async run(ctx: TuiSlashContext, args: string) {
    const action = args.trim().toLowerCase();
    if (action !== '' && action !== 'refresh') {
      ctx.tui.printError('Usage: /pr [refresh]');
      return { kind: 'handled' };
    }

    try {
      if (action === 'refresh') {
        // The one call in this file that may reach the hosting service.
        const result = await ctx.client.syncIntegrations(ctx.session.id);
        const records = await ctx.client.observeIntegrationsForSession(ctx.session.id);
        const lines = [...syncLines(result), ''];
        lines.push(...prLines(records));
        showPanel(ctx, 'Pull requests', lines, { footer: FOOTER, scrollable: true });
        return { kind: 'handled' };
      }

      const records = await ctx.client.observeIntegrationsForSession(ctx.session.id);
      showPanel(ctx, 'Pull requests', prLines(records), { footer: FOOTER, scrollable: true });
    } catch (error) {
      // A Host without an integration provider cannot answer; that is not the
      // same as "this session has no pull requests".
      const code = hostErrorCode(error);
      if (code === 'integration_api_unavailable') {
        showPanel(ctx, 'Pull requests', [
          'This Host does not serve the integration namespace, so it cannot answer.',
          '',
          '  That is different from "this session has no pull requests" — here',
          '  the question was never asked of an authority that could answer it.',
          '',
          '  Source: Host integration projection (GET /v1/integrations), 404 integration_api_unavailable.',
        ], { footer: FOOTER, scrollable: true });
        return { kind: 'handled' };
      }
      if (code === 'integration_sync_unavailable') {
        showPanel(ctx, 'Pull requests', [
          'This Host cannot refresh the integration projection.',
          '',
          describeError(error),
          '',
          '  Source: Host integration sync (POST /v1/integrations/sync), 404 integration_sync_unavailable.',
        ], { footer: FOOTER, scrollable: true });
        return { kind: 'handled' };
      }
      showPanel(ctx, 'Pull requests', [
        'Could not read the pull requests.',
        '',
        describeError(error),
        '',
        '  Source: Host integration projection (GET /v1/integrations).',
      ], { footer: FOOTER, scrollable: true });
    }
    return { kind: 'handled' };
  },
};

export const PR_COMMANDS: readonly TuiSlashCommandDef[] = [PR_COMMAND];
