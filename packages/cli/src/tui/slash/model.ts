/**
 * packages/cli/src/tui/slash/model.ts
 *
 * `/model` — show or switch the session model.
 *
 * Candidates come from the Host's own provider/model capability table
 * (`listProviderModelCapabilities`), which is the same table the Desktop
 * provider editor writes. The CLI deliberately does not read provider
 * config files: the Host owns that state, and a `duya tui` process may be
 * talking to a Desktop-managed Host or to its own ephemeral one.
 *
 * The switch is optimistic-concurrency safe: `update` carries
 * `expectedUpdatedAt`, so a session someone else touched (another TUI, the
 * Desktop) yields `conflict` instead of silently overwriting. The command
 * re-reads and retries rather than reporting a failure the user can do
 * nothing about.
 */

import type { HostSessionRecord } from '@duya/agent-protocol';
import type { TuiSlashCommandDef, TuiSlashContext, TuiSlashOutcome } from './types.js';
import { updateSession } from './shared.js';
import { formatTokenCount } from '../footer.js';
import type { TuiChoice } from '../TUIApp.js';

interface ModelChoice {
  readonly modelId: string;
  /** Columns shown after the model id: window size, current marker, flags. */
  readonly description: string;
  /** Current model first, then alphabetical — the row the user wants is at the top. */
  readonly isCurrent: boolean;
}

/** `1.0M ctx` / `200k ctx`, pi's thresholds rather than `1000k`. */
function describeWindow(window: number | undefined): string {
  return window === undefined || window <= 0 ? '' : `${formatTokenCount(window)} ctx`;
}

async function listCandidates(ctx: TuiSlashContext): Promise<ModelChoice[]> {
  const records = await ctx.client.listProviderModelCapabilities(ctx.session.providerId);
  const seen = new Set<string>();
  const choices: ModelChoice[] = [];
  for (const record of records) {
    const modelId = record.modelId.trim();
    if (modelId === '' || seen.has(modelId)) continue;
    seen.add(modelId);
    const flags = [
      describeWindow(record.contextWindow),
      record.supportsReasoning === true ? 'reasoning' : '',
      record.supportsVision === true ? 'vision' : '',
      modelId === ctx.session.model ? 'current' : '',
    ].filter((flag) => flag !== '');
    choices.push({ modelId, description: flags.join(' · '), isCurrent: modelId === ctx.session.model });
  }
  // The current model first: opening the picker is usually "what am I on, and
  // what else is there", and a list sorted purely by id buries the answer.
  return choices.sort((left, right) => {
    if (left.isCurrent !== right.isCurrent) return left.isCurrent ? -1 : 1;
    return left.modelId.localeCompare(right.modelId);
  });
}

async function applyModel(
  ctx: TuiSlashContext,
  model: string,
): Promise<HostSessionRecord> {
  return updateSession(ctx.client, ctx.session, { model });
}

function matchCandidate(choices: readonly ModelChoice[], query: string): ModelChoice | undefined {
  const normalized = query.trim().toLowerCase();
  if (normalized === '') return undefined;
  return choices.find((choice) => choice.modelId.toLowerCase() === normalized);
}

/** Case-insensitive substring hits, best (longest id) first. */
function suggestCandidates(
  choices: readonly ModelChoice[],
  query: string,
  limit = 6,
): ModelChoice[] {
  const normalized = query.trim().toLowerCase();
  if (normalized === '') return [];
  return choices
    .filter((choice) => choice.modelId.toLowerCase().includes(normalized))
    .sort((left, right) => right.modelId.length - left.modelId.length)
    .slice(0, limit);
}

const MODEL_COMMAND: TuiSlashCommandDef = {
  name: 'model',
  argsHint: '[model]',
  description: 'Show or switch the session model',
  group: 'Model',
  async run(ctx: TuiSlashContext, args: string): Promise<TuiSlashOutcome> {
    if (ctx.busy) {
      ctx.tui.printError('Cannot switch the model while a turn is running — press Esc first.');
      return { kind: 'handled' };
    }

    let choices: ModelChoice[];
    try {
      choices = await listCandidates(ctx);
    } catch (error) {
      ctx.tui.printError(
        `Failed to read models for provider ${ctx.session.providerId}: `
        + (error instanceof Error ? error.message : String(error)),
      );
      return { kind: 'handled' };
    }

    if (choices.length === 0) {
      ctx.tui.printError(
        `Provider ${ctx.session.providerId} has no models registered in the Host. `
        + 'Add one in the Desktop provider settings.',
      );
      return { kind: 'handled' };
    }

    const query = args.trim();
    let target: string;

    if (query === '') {
      const options: TuiChoice[] = choices.map((choice) => ({
        label: choice.modelId,
        value: choice.modelId,
        ...(choice.description === '' ? {} : { description: choice.description }),
      }));
      // pi's shape: a title that names the scope, a filter line the user can
      // type into, and the current model already marked in its own row.
      const title = `Select model · ${ctx.session.providerId}`;
      const footer = 'type to filter · ↑↓ choose · Enter switch · Esc cancel';
      const picked = ctx.tui.chooseFiltered === undefined
        ? await ctx.tui.choose(title, options)
        : await ctx.tui.chooseFiltered(title, options, { footer });
      if (picked === null) return { kind: 'handled' };
      target = picked;
    } else {
      const exact = matchCandidate(choices, query);
      if (exact === undefined) {
        const similar = suggestCandidates(choices, query);
        ctx.tui.printError(
          similar.length > 0
            ? `No model matches "${query}". Did you mean:\n`
              + similar.map((choice) => `  ${choice.modelId}`).join('\n')
            : `No model matches "${query}". Available:\n`
              + choices.slice(0, 8).map((choice) => `  ${choice.modelId}`).join('\n'),
        );
        return { kind: 'handled' };
      }
      target = exact.modelId;
    }

    if (target === ctx.session.model) {
      ctx.tui.printNotice(`Model is already ${target}.`);
      return { kind: 'handled' };
    }

    try {
      const session = await applyModel(ctx, target);
      ctx.tui.printNotice(`Model switched to ${session.model}.`);
      return { kind: 'session_updated', session };
    } catch (error) {
      ctx.tui.printError(
        `Model switch failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { kind: 'handled' };
    }
  },
};

export const MODEL_COMMANDS: readonly TuiSlashCommandDef[] = [MODEL_COMMAND];
