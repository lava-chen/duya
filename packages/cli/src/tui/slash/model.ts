/**
 * packages/cli/src/tui/slash/model.ts
 *
 * `/model` — show or switch the session model, across every provider.
 *
 * ## Where the candidates come from
 *
 * The Host's provider catalog (`getProviderCatalog`), which is read from the
 * configuration that actually decides which provider answers a request
 * (`~/.duya/config.toml`, `[providers.*]`). It lists EVERY configured provider
 * with the models it serves, enriched with the built-in model directory for
 * the facts a configuration file cannot carry — context window, reasoning
 * support and the thinking tiers a model accepts.
 *
 * This replaced an earlier version that read the Host's
 * `provider_model_capabilities` table. That table holds OVERRIDES written by
 * the Desktop provider editor and the models API — it is empty on every
 * machine whose providers came from the configuration file, so the picker
 * reported "no models registered" exactly where the most models were
 * configured. It also only ever described the CURRENT provider, so a model of
 * another provider could not be picked at all.
 *
 * ## Configured models and presets
 *
 * `enabled_models` is a list someone typed into a file, so a provider with a
 * dozen available models usually has two configured. The catalog carries the
 * vendor's preset list next to it (`presetModels`), and both are offered: the
 * configured rows first, then the presets marked `preset`. Picking a preset
 * switches the session without touching `config.toml` — `resolveModel` accepts
 * a model the provider serves but the configuration does not list, with a
 * warning rather than a refusal, and rewriting a hand-edited file from a
 * picker is not this command's business.
 *
 * ## Switching provider and model together
 *
 * A model only means something together with its provider, so the picker
 * carries both and the session is patched with both. The provider is taken
 * from the same configuration the run will resolve against, so a switch can
 * never leave the session pointing at a model its provider does not serve.
 *
 * The switch is optimistic-concurrency safe: `update` carries
 * `expectedUpdatedAt`, so a session someone else touched (another TUI, the
 * Desktop) yields `conflict` instead of silently overwriting. The command
 * re-reads and retries rather than reporting a failure the user can do
 * nothing about.
 */

import type { HostSessionRecord } from '@duya/agent-protocol';
import type {
  HostProviderCatalog,
  HostProviderCatalogModel,
  HostProviderCatalogProvider,
} from '@duya/agent-protocol/provider-catalog';
import type { TuiSlashCommandDef, TuiSlashContext, TuiSlashOutcome } from './types.js';
import { updateSession } from './shared.js';
import { formatTokenCount } from '../footer.js';
import type { TuiChoice } from '../TUIApp.js';

interface ModelChoice {
  readonly providerId: string;
  readonly providerName: string;
  readonly modelId: string;
  /** Columns shown after the model id: provider, window, flags, tiers. */
  readonly description: string;
  /** Current model first, then alphabetical — the row the user wants is at the top. */
  readonly isCurrent: boolean;
  /** False when the provider has no API key: the row would fail on the next turn. */
  readonly hasApiKey: boolean;
  /**
   * True when the model comes from the vendor's preset list rather than from
   * `enabled_models`. Shown as its own row, not merged into the configured
   * ones, because it is a different promise: the provider serves it, the
   * configuration does not claim to.
   */
  readonly isPreset: boolean;
}

/** `1.0M ctx` / `200k ctx`, pi's thresholds rather than `1000k`. */
function describeWindow(window: number | undefined): string {
  return window === undefined || window <= 0 ? '' : `${formatTokenCount(window)} ctx`;
}

/** The thinking tiers a model accepts, e.g. `low/medium/high/max`. */
function describeTiers(model: HostProviderCatalogModel): string {
  const tiers = model.reasoningEffortOptions ?? [];
  return tiers.length > 0 ? tiers.join('/') : '';
}

/**
 * The qualifier column of a row.
 *
 * The provider comes FIRST because it is the fact that distinguishes two
 * rows with the same model id — `MiniMax-M3` on MiniMax CN and on OpenRouter
 * are different models with different prices.
 */
function describeChoice(
  provider: HostProviderCatalogProvider,
  model: HostProviderCatalogModel,
  isCurrent: boolean,
  isPreset: boolean,
): string {
  const flags = [
    provider.name,
    describeWindow(model.contextWindow),
    model.supportsReasoning === true ? 'reasoning' : '',
    describeTiers(model),
    provider.hasApiKey ? '' : 'no API key',
    isPreset ? 'preset' : '',
    isCurrent ? 'current' : '',
  ].filter((flag) => flag !== '');
  return flags.join(' · ');
}

/**
 * Every model the catalog knows, ordered by how likely it is to be the one
 * the user wants: the current model, then the rest of the current provider,
 * then every other provider — and within a provider, its configured models
 * before its presets.
 */
function listChoices(catalog: HostProviderCatalog, session: HostSessionRecord): ModelChoice[] {
  const choices: ModelChoice[] = [];
  for (const provider of catalog.providers) {
    const rows: Array<{ model: HostProviderCatalogModel; isPreset: boolean }> = [
      ...provider.models.map((model) => ({ model, isPreset: false })),
      ...(provider.presetModels ?? []).map((model) => ({ model, isPreset: true })),
    ];
    for (const { model, isPreset } of rows) {
      const isCurrent = provider.providerId === session.providerId && model.modelId === session.model;
      choices.push({
        providerId: provider.providerId,
        providerName: provider.name,
        modelId: model.modelId,
        description: describeChoice(provider, model, isCurrent, isPreset),
        isCurrent,
        hasApiKey: provider.hasApiKey,
        isPreset,
      });
    }
  }
  return choices.sort((left, right) => {
    if (left.isCurrent !== right.isCurrent) return left.isCurrent ? -1 : 1;
    const leftSameProvider = left.providerId === session.providerId;
    const rightSameProvider = right.providerId === session.providerId;
    if (leftSameProvider !== rightSameProvider) return leftSameProvider ? -1 : 1;
    if (left.providerId !== right.providerId) return left.providerId.localeCompare(right.providerId);
    if (left.isPreset !== right.isPreset) return left.isPreset ? 1 : -1;
    return left.modelId.localeCompare(right.modelId);
  });
}

async function readCatalog(ctx: TuiSlashContext): Promise<HostProviderCatalog> {
  return ctx.client.getProviderCatalog();
}

/**
 * The provider-qualified spelling of a choice.
 *
 * `providerId::modelId` — the separator is not a character a provider or a
 * model id may contain, and the encoded form is what the picker returns, so
 * the row and the session patch cannot disagree about which model was picked.
 */
function encodeChoice(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`;
}

function decodeChoice(value: string): { providerId: string; modelId: string } | null {
  const separator = value.indexOf('::');
  if (separator <= 0) return null;
  return {
    providerId: value.slice(0, separator),
    modelId: value.slice(separator + 2),
  };
}

async function applyModel(
  ctx: TuiSlashContext,
  providerId: string,
  model: string,
): Promise<HostSessionRecord> {
  const patch = providerId === ctx.session.providerId
    ? { model }
    : { model, providerId };
  return updateSession(ctx.client, ctx.session, patch);
}

/**
 * A model named exactly, preferring the current provider when the name
 * repeats: two providers may serve the same model id, and the one the session
 * already uses is the one the user most likely means.
 */
function matchCandidate(
  choices: readonly ModelChoice[],
  query: string,
  currentProviderId: string,
): ModelChoice | undefined {
  const normalized = query.trim().toLowerCase();
  if (normalized === '') return undefined;
  const exact = choices.filter((choice) => choice.modelId.toLowerCase() === normalized);
  if (exact.length === 0) return undefined;
  return exact.find((choice) => choice.providerId === currentProviderId) ?? exact[0];
}

/**
 * A model named together with its provider: `minimax-cn/MiniMax-M3` or
 * `minimax-cn:MiniMax-M3`.
 *
 * This is the spelling that disambiguates two providers serving the same
 * model id, and the one a user copies out of the configuration file.
 */
function matchQualified(
  choices: readonly ModelChoice[],
  query: string,
): ModelChoice | undefined {
  const trimmed = query.trim();
  const separator = trimmed.search(/[:/]/u);
  if (separator <= 0) return undefined;
  const providerId = trimmed.slice(0, separator).trim().toLowerCase();
  const modelId = trimmed.slice(separator + 1).trim().toLowerCase();
  if (providerId === '' || modelId === '') return undefined;
  return choices.find(
    (choice) => choice.providerId.toLowerCase() === providerId
      && choice.modelId.toLowerCase() === modelId,
  );
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
    .filter(
      (choice) => choice.modelId.toLowerCase().includes(normalized)
        || choice.providerId.toLowerCase().includes(normalized),
    )
    .sort((left, right) => right.modelId.length - left.modelId.length)
    .slice(0, limit);
}

/**
 * The candidates of a Host that predates the catalog route.
 *
 * A `duya tui` can attach to a RUNNING Desktop Host (`attachedHostFromEnv`),
 * and that Host may be an older build without `/v1/local/provider-catalog`.
 * The override table still describes the CURRENT provider, so the picker
 * keeps working — with less to show, which is the honest trade.
 */
async function legacyChoices(ctx: TuiSlashContext): Promise<ModelChoice[] | null> {
  try {
    const records = await ctx.client.listProviderModelCapabilities(ctx.session.providerId);
    const choices: ModelChoice[] = [];
    const seen = new Set<string>();
    for (const record of records) {
      const modelId = record.modelId.trim();
      if (modelId === '' || seen.has(modelId)) continue;
      seen.add(modelId);
      const isCurrent = modelId === ctx.session.model;
      const flags = [
        describeWindow(record.contextWindow),
        record.supportsReasoning === true ? 'reasoning' : '',
        isCurrent ? 'current' : '',
      ].filter((flag) => flag !== '');
      choices.push({
        providerId: ctx.session.providerId,
        providerName: ctx.session.providerId,
        modelId,
        description: flags.join(' · '),
        isCurrent,
        hasApiKey: true,
        isPreset: false,
      });
    }
    return choices;
  } catch {
    return null;
  }
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
    let configRoot: string;
    try {
      const catalog = await readCatalog(ctx);
      if (catalog.error !== undefined && catalog.providers.length === 0) {
        ctx.tui.printError(catalog.error);
        return { kind: 'handled' };
      }
      choices = listChoices(catalog, ctx.session);
      configRoot = catalog.configRoot;
    } catch (error) {
      const legacy = await legacyChoices(ctx);
      if (legacy === null || legacy.length === 0) {
        ctx.tui.printError(
          'Failed to read the provider catalog: '
          + (error instanceof Error ? error.message : String(error)),
        );
        return { kind: 'handled' };
      }
      choices = legacy;
      configRoot = '';
    }

    if (choices.length === 0) {
      ctx.tui.printError(
        `No models are configured in ${configRoot}. `
        + 'Add a provider with `enabled_models` to the configuration file.',
      );
      return { kind: 'handled' };
    }

    const query = args.trim();
    let picked: ModelChoice | undefined;

    if (query === '') {
      const options: TuiChoice[] = choices.map((choice) => ({
        label: choice.modelId,
        value: encodeChoice(choice.providerId, choice.modelId),
        ...(choice.description === '' ? {} : { description: choice.description }),
      }));
      // pi's shape: a title that names the scope, a filter line the user can
      // type into, and the current model already marked in its own row.
      const providerCount = new Set(choices.map((choice) => choice.providerId)).size;
      const title = `Select model · ${providerCount} provider${providerCount === 1 ? '' : 's'}`;
      const footer = 'type to filter · ↑↓ choose · Enter switch · Esc cancel';
      const selected = ctx.tui.chooseFiltered === undefined
        ? await ctx.tui.choose(title, options)
        : await ctx.tui.chooseFiltered(title, options, { footer });
      if (selected === null) return { kind: 'handled' };
      const decoded = decodeChoice(selected);
      if (decoded === null) {
        ctx.tui.printError(`The picker returned an unusable value: ${selected}`);
        return { kind: 'handled' };
      }
      picked = choices.find(
        (choice) => choice.providerId === decoded.providerId && choice.modelId === decoded.modelId,
      );
      if (picked === undefined) return { kind: 'handled' };
    } else {
      const qualified = matchQualified(choices, query);
      const exact = qualified ?? matchCandidate(choices, query, ctx.session.providerId);
      if (exact === undefined) {
        const similar = suggestCandidates(choices, query);
        ctx.tui.printError(
          similar.length > 0
            ? `No model matches "${query}". Did you mean:\n`
              + similar.map((choice) => `  ${choice.providerId}/${choice.modelId}`).join('\n')
            : `No model matches "${query}". Available:\n`
              + choices.slice(0, 8).map((choice) => `  ${choice.providerId}/${choice.modelId}`).join('\n'),
        );
        return { kind: 'handled' };
      }
      picked = exact;
    }

    if (picked.providerId === ctx.session.providerId && picked.modelId === ctx.session.model) {
      ctx.tui.printNotice(`Model is already ${picked.modelId} (${picked.providerName}).`);
      return { kind: 'handled' };
    }

    if (!picked.hasApiKey) {
      // Not a refusal: the provider may still be served by a key that lives
      // somewhere this catalog cannot see (an environment variable, a desktop
      // credential). The warning names the gap instead of pretending to know
      // the run will fail.
      ctx.tui.printNotice(
        `Provider "${picked.providerId}" has no API key in ${configRoot}/secrets.json. `
        + 'The switch still happened — the next turn will fail unless the key is provided elsewhere.',
      );
    }

    try {
      const session = await applyModel(ctx, picked.providerId, picked.modelId);
      const providerChanged = picked.providerId !== ctx.session.providerId;
      ctx.tui.printNotice(
        `Model switched to ${session.model} (${picked.providerName}).`
        + (providerChanged ? ' Provider changed too.' : '')
        // A preset is not configured: the session now names a model the
        // provider serves and `enabled_models` does not, which `resolveModel`
        // accepts with a warning. Saying so is the difference between "I
        // picked a model" and "I changed my configuration".
        + (picked.isPreset
          ? ` ${picked.modelId} is a ${picked.providerName} preset, so it is not written into config.toml.`
          : ''),
      );
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
