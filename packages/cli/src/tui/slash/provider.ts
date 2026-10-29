/**
 * packages/cli/src/tui/slash/provider.ts
 *
 * `/provider` — add a model provider, or change what an existing one points at.
 *
 * The Host owns both halves: the `[providers.*]` tables in `config.toml` and the
 * key under `providers.<id>.apiKey` in `secrets.json`. Nothing here reads or
 * writes either file. No type crossing this boundary carries a key inward (it is
 * write-only) or outward (only `hasApiKey` and a mask), so the terminal never
 * holds a credential it could leak into a scrollback or a log line.
 *
 * ## Why the flow is save-then-test, not test-then-save
 *
 * The probe route takes a provider *id*, not a URL plus a key — that is what
 * keeps the key inside the Host process. An unsaved provider therefore cannot be
 * probed, and the plan's "test before saving" has to become: save, test, and put
 * the previous row back when the test fails. {@link addProvider} deletes the row
 * it just created and {@link changeProvider} rewrites the row it replaced, so a
 * failed test leaves the configuration exactly as it was.
 *
 * ## Why every write echoes the whole row
 *
 * `HostProviderWriteInput`'s declared fields are REPLACED, not merged — omitting
 * `alias` clears it. A command that sent only the field it changed would blank
 * every other one, so the writers below start from the row they read and overlay
 * the one field the user edited. Every write also echoes the list's `revision`,
 * which turns "someone else changed the file between my read and my write" into a
 * refusal instead of a silent overwrite.
 */

import { BUILTIN_CATALOG } from '@duya/ai';
import type {
  HostProviderDetail,
  HostProviderList,
  HostProviderTestResult,
  HostProviderWriteInput,
} from '@duya/agent-protocol';
import type { TuiChoice } from '../TUIApp.js';
import { describeError } from './shared.js';
import type { TuiSlashCommandDef, TuiSlashContext, TuiSlashOutcome } from './types.js';

/**
 * The provider types the Host can actually resolve.
 *
 * `mapProviderType` in `worker-config/file-config.ts` maps exactly these to a
 * wire protocol and returns `undefined` for anything else — a provider saved
 * under a type outside this list would list, probe and then fail to build a
 * client at run time. The wizard therefore offers this list rather than free
 * text.
 */
const PROVIDER_TYPES: readonly TuiChoice[] = [
  {
    label: 'openai-compatible',
    value: 'openai-compatible',
    description: 'Chat Completions — most third-party and self-hosted endpoints',
  },
  {
    label: 'anthropic',
    value: 'anthropic',
    description: 'Claude Messages API',
  },
  {
    label: 'openrouter',
    value: 'openrouter',
    description: 'OpenRouter aggregation',
  },
];

/** `[providers.<id>]` is a TOML table key, so an id has to survive as one. */
const PROVIDER_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]*$/u;

/**
 * A write gathered one answer at a time.
 *
 * `HostProviderWriteInput` is readonly because it crosses the wire; this is the
 * mutable shape the edit form fills in before handing it over once. A mutable
 * object is assignable to the readonly protocol type, so the draft never needs
 * a cast at the boundary.
 */
interface ProviderDraft {
  providerId: string;
  name: string;
  alias: string;
  providerType: string;
  baseUrl: string;
  models: readonly string[];
  defaultModel: string;
  expectedRevision: string;
  apiKey?: string;
}

/** Models reach the Host as a list, and people type them as a string. */
function splitModels(raw: string): readonly string[] {
  return [...new Set(raw.split(/[,\n]/u).map((id) => id.trim()).filter(Boolean))];
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** What the vendor said about the connection, in one line the user can act on. */
function describeProbe(result: HostProviderTestResult): string {
  const models = result.modelIds?.length ?? 0;
  const latency = `${result.latencyMs} ms`;
  return result.message ? `${result.message} (${latency})` : `${models} models · ${latency}`;
}

/** The preset entry a configured provider most likely came from. */
function presetFor(detail: HostProviderDetail) {
  const entries = BUILTIN_CATALOG.list();
  return (
    entries.find((entry) => entry.baseUrl === detail.baseUrl) ??
    entries.find((entry) => entry.name.toLowerCase() === detail.name.toLowerCase())
  );
}

/**
 * The catalog entry the add wizard should seed the rest of its questions from.
 *
 * The chosen `providerType` is what the runtime needs; the catalog is what the
 * user would otherwise have to remember (a vendor's base URL and its current
 * model ids). Matching on protocol keeps the seed from contradicting the type.
 */
function presetForProviderType(providerType: string) {
  const wanted = providerType === 'anthropic' ? 'anthropic' : 'openai-chat';
  return BUILTIN_CATALOG.list().find((entry) => entry.protocol === wanted);
}

/**
 * Ask for the model list, offering what the vendor ships as the starting point.
 *
 * Two sources feed the default: the provider's own presets from `@duya/ai`
 * (refreshed on a schedule, so a vendor's new models arrive without an edit to
 * this file) and whatever the endpoint just reported. Both are only a
 * suggestion — the field is plain text, because `enabled_models` is a
 * hand-written list and a provider may serve ids neither source knows.
 */
async function promptModels(
  ctx: TuiSlashContext,
  detail: HostProviderDetail,
  probed: readonly string[] | undefined,
): Promise<readonly string[] | undefined> {
  const preset = presetFor(detail);
  const candidates = [
    ...new Set([
      ...detail.models,
      ...(probed ?? []),
      ...(preset?.defaultModels.map((model) => model.modelId) ?? []),
    ]),
  ];
  const initial = candidates.length > 0 ? candidates : detail.models;
  const answer = await ctx.tui.promptText?.(
    `Models for ${detail.name} (comma separated)`,
    {
      initialValue: initial.join(', '),
      placeholder: 'gpt-4o, gpt-4o-mini',
    },
  );
  if (answer === null || answer === undefined) return undefined;
  const models = splitModels(answer);
  if (models.length === 0) {
    ctx.tui.printError('At least one model is required.');
    return undefined;
  }
  return models;
}

/**
 * Save one provider row and keep it usable.
 *
 * `previous` is the row this write replaces, if any. A failed probe restores it,
 * which is the only thing standing between "the connection I had" and "a row
 * that points somewhere broken" — the write already landed by the time the
 * probe runs.
 */
async function writeProvider(
  ctx: TuiSlashContext,
  input: HostProviderWriteInput,
  previous: HostProviderDetail | undefined,
): Promise<boolean> {
  try {
    const saved = await ctx.client.upsertProvider(input);
    const providerId = saved.provider.providerId;
    const probe = await ctx.client.testProvider(providerId);
    if (!probe.ok) {
      if (previous === undefined) {
        await ctx.client.deleteProvider(providerId, saved.revision).catch(() => undefined);
        ctx.tui.printError(`Saved and removed again: the connection test failed — ${describeProbe(probe)}`);
        return false;
      }
      await ctx.client
        .upsertProvider({
          providerId: previous.providerId,
          name: previous.name,
          alias: previous.alias ?? '',
          providerType: previous.providerType,
          baseUrl: previous.baseUrl,
          models: previous.models,
          defaultModel: previous.defaultModel ?? '',
          expectedRevision: saved.revision,
        })
        .catch(() => undefined);
      ctx.tui.printError(`Restored the previous settings: the connection test failed — ${describeProbe(probe)}`);
      return false;
    }
    ctx.tui.printNotice(
      // Keyed on whether a row was replaced, not on whether the input carried
      // an id: the wizard names the id it is about to create, so an absent
      // `providerId` would report every new provider as an update.
      `${previous === undefined ? 'Added' : 'Updated'} ${saved.provider.name} (${providerId}) · ${describeProbe(probe)}`,
    );
    return true;
  } catch (error) {
    ctx.tui.printError(describeError(error));
    return false;
  }
}

/** Walk the questions a new provider needs, then save and probe it. */
async function addProvider(ctx: TuiSlashContext, list: HostProviderList): Promise<void> {
  const promptText = ctx.tui.promptText;
  if (promptText === undefined) {
    ctx.tui.printError('This terminal cannot prompt for provider details.');
    return;
  }

  const rawId = await promptText('Provider id', {
    placeholder: 'deepseek',
  });
  if (rawId === null) return;
  const providerId = rawId.trim();
  if (!PROVIDER_ID_PATTERN.test(providerId)) {
    ctx.tui.printError('A provider id starts with a letter and holds only letters, digits, ".", "_" or "-".');
    return;
  }
  if (list.providers.some((provider) => provider.providerId === providerId)) {
    ctx.tui.printError(`${providerId} already exists. Use /provider ${providerId} to change it.`);
    return;
  }

  const providerType = await ctx.tui.choose('API format', PROVIDER_TYPES);
  if (providerType === null) return;

  const preset = presetForProviderType(providerType);
  const rawName = await promptText('Display name', { initialValue: preset?.name ?? providerId });
  if (rawName === null) return;
  const name = rawName.trim() || providerId;

  const rawBaseUrl = await promptText('Base URL', {
    initialValue: preset?.baseUrl ?? '',
    placeholder: 'https://api.example.com/v1',
  });
  if (rawBaseUrl === null) return;
  const baseUrl = rawBaseUrl.trim();
  if (!isHttpUrl(baseUrl)) {
    ctx.tui.printError('Base URL must use http or https.');
    return;
  }

  const rawModels = await promptText('Models (comma separated)', {
    initialValue: preset?.defaultModels.map((model) => model.modelId).join(', ') ?? '',
    placeholder: 'gpt-4o, gpt-4o-mini',
  });
  if (rawModels === null) return;
  const models = splitModels(rawModels);
  if (models.length === 0) {
    ctx.tui.printError('At least one model is required.');
    return;
  }

  const rawApiKey = await promptText('API key', { secret: true, placeholder: 'sk-…' });
  if (rawApiKey === null) return;
  const apiKey = rawApiKey.trim();
  if (apiKey.length === 0) {
    ctx.tui.printError('An API key is required for a new provider.');
    return;
  }

  await writeProvider(
    ctx,
    {
      providerId,
      name,
      providerType,
      baseUrl,
      models,
      defaultModel: models[0],
      apiKey,
    },
    undefined,
  );
}

/** Change one field of an existing provider, or just probe it. */
async function changeProvider(
  ctx: TuiSlashContext,
  list: HostProviderList,
  detail: HostProviderDetail,
): Promise<void> {
  const promptText = ctx.tui.promptText;
  if (promptText === undefined) {
    ctx.tui.printError('This terminal cannot prompt for provider details.');
    return;
  }

  const key = detail.hasApiKey ? `key ${detail.maskedApiKey}` : 'no key';
  const action = await ctx.tui.choose(`Edit ${detail.name}`, [
    {
      label: 'Model list',
      value: 'models',
      description: `${detail.models.length} enabled · ${detail.models.slice(0, 3).join(', ') || 'none'}`,
    },
    { label: 'Base URL', value: 'baseUrl', description: detail.baseUrl },
    { label: 'API key', value: 'apiKey', description: key },
    {
      label: 'Alias',
      value: 'alias',
      description: detail.alias ?? 'not set',
    },
    {
      label: 'Test connection',
      value: 'test',
      description: 'Probe the endpoint with the stored key',
    },
  ]);
  if (action === null) return;

  if (action === 'test') {
    try {
      const probe = await ctx.client.testProvider(detail.providerId);
      if (probe.ok) ctx.tui.printNotice(`${detail.name}: ${describeProbe(probe)}`);
      else ctx.tui.printError(`${detail.name}: ${describeProbe(probe)}`);
    } catch (error) {
      ctx.tui.printError(describeError(error));
    }
    return;
  }

  // Everything below writes, so start from the row as read and overlay one field.
  const draft: ProviderDraft = {
    providerId: detail.providerId,
    name: detail.name,
    alias: detail.alias ?? '',
    providerType: detail.providerType,
    baseUrl: detail.baseUrl,
    models: detail.models,
    defaultModel: detail.defaultModel ?? '',
    expectedRevision: list.revision,
  };

  if (action === 'models') {
    // Probe first: the endpoint's own list is the only source that knows what
    // this key can actually reach. A failed probe is not fatal — the user still
    // gets to edit the list from the presets.
    let probed: readonly string[] | undefined;
    try {
      const result = await ctx.client.testProvider(detail.providerId);
      if (result.ok) probed = result.modelIds;
      else ctx.tui.printError(`Could not reach ${detail.name}; editing from the presets — ${describeProbe(result)}`);
    } catch (error) {
      ctx.tui.printError(`Could not reach ${detail.name}; editing from the presets — ${describeError(error)}`);
    }
    const models = await promptModels(ctx, detail, probed);
    if (models === undefined) return;
    draft.models = models;
    // `defaultModel` is replaced too: keep it only while it is still offered.
    draft.defaultModel =
      detail.defaultModel !== undefined && models.includes(detail.defaultModel)
        ? detail.defaultModel
        : (models[0] ?? '');
  } else if (action === 'baseUrl') {
    const answer = await promptText('Base URL', { initialValue: detail.baseUrl });
    if (answer === null) return;
    const baseUrl = answer.trim();
    if (!isHttpUrl(baseUrl)) {
      ctx.tui.printError('Base URL must use http or https.');
      return;
    }
    draft.baseUrl = baseUrl;
  } else if (action === 'apiKey') {
    const answer = await promptText('New API key', { secret: true, placeholder: 'sk-…' });
    if (answer === null) return;
    const apiKey = answer.trim();
    if (apiKey.length === 0) {
      ctx.tui.printError('An empty key is refused; the stored one is unchanged.');
      return;
    }
    draft.apiKey = apiKey;
  } else if (action === 'alias') {
    const answer = await promptText('Alias (blank clears it)', { initialValue: detail.alias ?? '' });
    if (answer === null) return;
    draft.alias = answer.trim();
  }

  await writeProvider(ctx, draft, detail);
}

async function runProvider(ctx: TuiSlashContext, args: string): Promise<TuiSlashOutcome> {
  // A provider write while a turn streams would swap the row the running turn
  // already resolved against. Every other config command refuses the same way.
  if (ctx.busy) {
    ctx.tui.printError('Provider changes wait for the running turn to finish.');
    return { kind: 'handled' };
  }

  let list: HostProviderList;
  try {
    list = await ctx.client.listProviders();
  } catch (error) {
    ctx.tui.printError(describeError(error));
    return { kind: 'handled' };
  }
  // A malformed config is a reportable state: name the file, do not show "none".
  if (list.error !== undefined) {
    ctx.tui.printError(`${list.error} (${list.configRoot})`);
    return { kind: 'handled' };
  }

  const requested = args.trim();
  if (requested === 'add') {
    await addProvider(ctx, list);
    return { kind: 'handled' };
  }
  if (requested.length > 0) {
    const named = list.providers.find(
      (provider) => provider.providerId === requested || provider.name === requested,
    );
    if (named === undefined) {
      ctx.tui.printError(`No provider named ${requested}.`);
      return { kind: 'handled' };
    }
    await changeProvider(ctx, list, named);
    return { kind: 'handled' };
  }

  if (list.providers.length === 0) {
    ctx.tui.printNotice(`No providers are configured yet (${list.configRoot}).`);
    await addProvider(ctx, list);
    return { kind: 'handled' };
  }

  const picked = await ctx.tui.choose(
    'Model providers',
    [
      ...list.providers.map((provider) => ({
        label: `${provider.name}${provider.isDefault ? ' (default)' : ''}`,
        value: provider.providerId,
        description: [
          provider.providerId,
          provider.providerType,
          `${provider.models.length} models`,
          provider.hasApiKey ? provider.maskedApiKey : 'no key',
        ].join(' · '),
      })),
      { label: 'Add a provider…', value: '\u0000add', description: 'Name, endpoint, models and key' },
    ],
  );
  if (picked === null) return { kind: 'handled' };
  if (picked === '\u0000add') {
    await addProvider(ctx, list);
    return { kind: 'handled' };
  }
  const detail = list.providers.find((provider) => provider.providerId === picked);
  if (detail === undefined) return { kind: 'handled' };
  await changeProvider(ctx, list, detail);
  return { kind: 'handled' };
}

export const PROVIDER_COMMANDS: readonly TuiSlashCommandDef[] = [
  {
    name: 'provider',
    argsHint: '[add|<id>]',
    description: 'Add a model provider, or change one',
    group: 'Settings',
    run: runProvider,
  },
];
