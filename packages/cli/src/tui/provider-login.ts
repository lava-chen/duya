import {
  connectProviderManagementApi,
  type ManagedProvider,
  type ProviderManagementApi,
} from '../providers.js';
import type { TUIApp, TuiChoice } from './TUIApp.js';

export type ProviderLoginAction = 'add' | 'manage';
export type ProviderApiFactory = () => Promise<ProviderManagementApi>;

/** Catalog data supplied by the host so the CLI package stays independent of the AI runtime. */
export interface ProviderRegistrationPreset {
  readonly id: string;
  readonly name: string;
  readonly descriptionZh: string;
  readonly protocol: string;
  readonly legacyProtocol?: string;
  readonly baseUrl: string;
  readonly envOverrides?: Readonly<Record<string, string>>;
  readonly category?: string;
  readonly authTypes: readonly string[];
  readonly authFields?: readonly { readonly key: string; readonly required: boolean }[];
  readonly defaultModels: readonly { readonly modelId: string; readonly displayName: string }[];
}

/** Run the provider registration/management flow inside the chat TUI. */
export async function runProviderLogin(
  tui: Pick<TUIApp, 'choose' | 'promptText' | 'printNotice' | 'printError'>,
  action: ProviderLoginAction,
  presets: readonly ProviderRegistrationPreset[],
  connect: ProviderApiFactory = connectProviderManagementApi,
): Promise<void> {
  let api: ProviderManagementApi;
  try {
    api = await connect();
  } catch (error) {
    tui.printError(readableError(error));
    return;
  }

  if (action === 'add') {
    await addProvider(tui, api, presets);
  } else {
    await manageProviders(tui, api);
  }
}

async function addProvider(
  tui: Pick<TUIApp, 'choose' | 'promptText' | 'printNotice' | 'printError'>,
  api: ProviderManagementApi,
  catalog: readonly ProviderRegistrationPreset[],
): Promise<void> {
  let providers: ManagedProvider[];
  try {
    providers = await api.list();
  } catch (error) {
    tui.printError(readableError(error));
    return;
  }

  const presets = catalog.filter((entry) => entry.category !== 'media');
  const selected = await tui.choose('Add a provider', presets.map((entry) => ({
    label: entry.name,
    value: entry.id,
    description: entry.descriptionZh,
  })));
  if (selected === null) return;
  const preset = presets.find((entry) => entry.id === selected);
  if (preset === undefined) return;

  const takenIds = new Set(providers.map((provider) => provider.id.toLowerCase()));
  const defaultId = uniqueId(preset.id, takenIds);
  const id = await tui.promptText('Provider ID', { initialValue: defaultId });
  if (id === null) return;
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/iu.test(id.trim())) {
    tui.printError('Provider ID must start with a letter or number and use only letters, numbers, ., _ or -.');
    return;
  }
  const normalizedId = id.trim();
  if (takenIds.has(normalizedId.toLowerCase())) {
    tui.printError(`Provider ID '${normalizedId}' already exists. Choose a different ID.`);
    return;
  }

  const name = await tui.promptText('Display name', { initialValue: preset.name });
  if (name === null) return;
  if (name.trim() === '') {
    tui.printError('Display name cannot be empty.');
    return;
  }

  const baseUrl = await tui.promptText('Base URL', {
    initialValue: preset.baseUrl,
    placeholder: 'https://…',
  });
  if (baseUrl === null) return;

  const needsApiKey = preset.authFields?.some((field) => field.key === 'api_key' && field.required)
    ?? preset.authTypes.some((type) => type === 'api_key' || type === 'auth_token');
  let apiKey = '';
  if (needsApiKey) {
    const value = await tui.promptText('API key', { secret: true, placeholder: 'Paste API key' });
    if (value === null) return;
    if (value.trim() === '') {
      tui.printError('API key cannot be empty.');
      return;
    }
    apiKey = value.trim();
  }

  const models = preset.defaultModels;
  let model: string | undefined;
  if (models.length === 1) {
    model = models[0]?.modelId;
  } else if (models.length > 1) {
    const selectedModel = await tui.choose('Choose a default model', models.map((item) => ({
      label: item.displayName,
      value: item.modelId,
      description: item.modelId,
    })));
    if (selectedModel === null) return;
    model = selectedModel;
  } else {
    const value = await tui.promptText('Default model ID', { placeholder: 'model-name' });
    if (value === null) return;
    model = value.trim() || undefined;
  }

  const providerType = preset.legacyProtocol ?? protocolToLegacyType(preset.protocol);
  let savedProvider: ManagedProvider;
  try {
    savedProvider = await api.add({
      id: normalizedId,
      name: name.trim(),
      providerType,
      baseUrl: baseUrl.trim(),
      apiKey,
      ...(model ? { model } : {}),
      ...(models.length > 0 ? { models: models.map((item) => item.modelId) } : {}),
      ...(preset.envOverrides && Object.keys(preset.envOverrides).length > 0
        ? { extraEnv: { ...preset.envOverrides } }
        : {}),
    });
  } catch (error) {
    tui.printError(readableError(error, [apiKey]));
    return;
  } finally {
    apiKey = '';
  }

  try {
    await api.setDefault(savedProvider.id);
    tui.printNotice(`Saved ${savedProvider.name} to Desktop providers and set it as the Desktop default.`);
  } catch (error) {
    tui.printNotice(`Saved ${savedProvider.name} to Desktop providers.`);
    tui.printError(`Could not set it as the Desktop default: ${readableError(error)}`);
  }
  tui.printNotice('The running chat-cli keeps its startup provider; the CLI does not hot-switch credentials yet.');
}

async function manageProviders(
  tui: Pick<TUIApp, 'choose' | 'promptText' | 'printNotice' | 'printError'>,
  api: ProviderManagementApi,
): Promise<void> {
  let providers: ManagedProvider[];
  try {
    providers = await api.list();
  } catch (error) {
    tui.printError(readableError(error));
    return;
  }
  if (providers.length === 0) {
    tui.printNotice('No providers are configured in Desktop yet. Choose /login add to connect one.');
    return;
  }

  const id = await tui.choose('Manage a provider', providers.map(providerChoice));
  if (id === null) return;
  const provider = providers.find((item) => item.id === id);
  if (provider === undefined) return;

  const action = await tui.choose(`Manage ${provider.name}`, [
    { label: 'Set as Desktop default', value: 'default', description: 'Used by Desktop features without an explicit provider' },
    { label: 'Remove provider', value: 'remove', description: 'Delete this provider from Desktop settings' },
    { label: 'Back', value: 'back' },
  ]);
  if (action === null || action === 'back') return;

  if (action === 'default') {
    try {
      await api.setDefault(provider.id);
      tui.printNotice(`${provider.name} is now the Desktop default provider.`);
      tui.printNotice('The running chat-cli keeps its startup provider; the CLI does not hot-switch credentials yet.');
    } catch (error) {
      tui.printError(readableError(error));
    }
    return;
  }

  const confirm = await tui.choose(`Remove ${provider.name}?`, [
    { label: 'Remove provider', value: 'yes' },
    { label: 'Keep provider', value: 'no' },
  ]);
  if (confirm !== 'yes') return;
  try {
    await api.remove(provider.id);
    tui.printNotice(`Removed ${provider.name} from Desktop providers.`);
  } catch (error) {
    tui.printError(readableError(error));
  }
}

function providerChoice(provider: ManagedProvider): TuiChoice {
  const markers = [
    provider.isDefault ? 'default' : '',
    provider.hasKey ? 'key configured' : 'no key',
  ].filter(Boolean).join(' · ');
  return {
    label: `${provider.name} (${provider.id})`,
    value: provider.id,
    description: `${provider.providerType} · ${markers}`,
  };
}

function uniqueId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base.toLowerCase())) return base;
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`.toLowerCase())) suffix += 1;
  return `${base}-${suffix}`;
}

function protocolToLegacyType(protocol: string): string {
  switch (protocol) {
    case 'anthropic': return 'anthropic';
    case 'openai-chat':
    case 'openai-responses': return 'openai-compatible';
    case 'openrouter': return 'openrouter';
    case 'ollama': return 'ollama';
    case 'gemini': return 'google';
    case 'bedrock': return 'bedrock';
    case 'vertex': return 'vertex';
    default: return 'openai-compatible';
  }
}

function readableError(error: unknown, secrets: readonly string[] = []): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (secret !== '') message = message.replaceAll(secret, '[redacted]');
  }
  return message;
}
