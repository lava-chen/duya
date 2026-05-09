/**
 * Setup Wizard for DUYA Agent CLI
 *
 * Interactive configuration wizard inspired by hermes-agent.
 * Stores configuration in the same database as the app.
 */

import {
  promptText,
  promptSecret,
  promptConfirm,
  promptSelect,
  promptCheckbox,
} from '../ui/prompts.js';
import { Colors, color, bold } from '../colors.js';
import {
  initCliDatabase,
  getAllCliProviders,
  getActiveCliProvider,
  upsertCliProvider,
  activateCliProvider,
  deleteCliProvider,
  getCliSetting,
  setCliSetting,
  getCliSettingJson,
  setCliSettingJson,
  maskApiKey,
  type CliProvider,
} from '../config/db-config.js';

// Provider presets matching the app's VENDOR_PRESETS
interface ProviderPreset {
  key: string;
  name: string;
  description: string;
  providerType: string;
  baseUrl: string;
  envVar: string;
  models: string[];
  defaultModel: string;
  extraEnv?: Record<string, string>;
}

const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    key: 'anthropic-official',
    name: 'Anthropic',
    description: 'Anthropic official Claude API',
    providerType: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    envVar: 'ANTHROPIC_API_KEY',
    models: ['claude-sonnet-4-20250514', 'claude-opus-4-20250514', 'claude-haiku-4-20250514'],
    defaultModel: 'claude-sonnet-4-20250514',
  },
  {
    key: 'openrouter',
    name: 'OpenRouter',
    description: 'Access 100+ models via OpenRouter',
    providerType: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    envVar: 'OPENROUTER_API_KEY',
    models: ['anthropic/claude-3.5-sonnet', 'openai/gpt-4o', 'google/gemini-pro'],
    defaultModel: 'anthropic/claude-3.5-sonnet',
  },
  {
    key: 'glm-cn',
    name: 'GLM (CN) - 智谱',
    description: 'Zhipu GLM Code Plan - China region',
    providerType: 'anthropic',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    envVar: 'ANTHROPIC_API_KEY',
    models: ['glm-5-turbo', 'glm-5.1', 'glm-4.5-air'],
    defaultModel: 'glm-5-turbo',
    extraEnv: { API_TIMEOUT_MS: '3000000' },
  },
  {
    key: 'glm-global',
    name: 'GLM (Global) - 智谱',
    description: 'Zhipu GLM Code Plan - Global region',
    providerType: 'anthropic',
    baseUrl: 'https://api.z.ai/api/anthropic',
    envVar: 'ANTHROPIC_API_KEY',
    models: ['glm-5-turbo', 'glm-5.1', 'glm-4.5-air'],
    defaultModel: 'glm-5-turbo',
    extraEnv: { API_TIMEOUT_MS: '3000000' },
  },
  {
    key: 'kimi',
    name: 'Kimi - 月之暗面',
    description: 'Kimi Coding Plan API',
    providerType: 'anthropic',
    baseUrl: 'https://api.kimi.com/coding/',
    envVar: 'ANTHROPIC_API_KEY',
    models: ['kimi-k2.5'],
    defaultModel: 'kimi-k2.5',
    extraEnv: { ENABLE_TOOL_SEARCH: 'false' },
  },
  {
    key: 'moonshot',
    name: 'Moonshot',
    description: 'Moonshot AI API',
    providerType: 'anthropic',
    baseUrl: 'https://api.moonshot.cn/anthropic',
    envVar: 'ANTHROPIC_API_KEY',
    models: ['kimi-k2.5'],
    defaultModel: 'kimi-k2.5',
    extraEnv: { ENABLE_TOOL_SEARCH: 'false' },
  },
  {
    key: 'minimax-cn',
    name: 'MiniMax (CN)',
    description: 'MiniMax Code Plan - China region',
    providerType: 'anthropic',
    baseUrl: 'https://api.minimaxi.com/anthropic',
    envVar: 'ANTHROPIC_API_KEY',
    models: ['MiniMax-M2.7'],
    defaultModel: 'MiniMax-M2.7',
    extraEnv: { API_TIMEOUT_MS: '3000000', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
  },
  {
    key: 'minimax-global',
    name: 'MiniMax (Global)',
    description: 'MiniMax Code Plan - Global region',
    providerType: 'anthropic',
    baseUrl: 'https://api.minimax.io/anthropic',
    envVar: 'ANTHROPIC_API_KEY',
    models: ['MiniMax-M2.7'],
    defaultModel: 'MiniMax-M2.7',
    extraEnv: { API_TIMEOUT_MS: '3000000', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
  },
  {
    key: 'volcengine',
    name: 'Volcengine Ark - 火山方舟',
    description: 'ByteDance Volcengine Ark Coding Plan',
    providerType: 'anthropic',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/coding',
    envVar: 'ANTHROPIC_API_KEY',
    models: ['doubao-pro', 'doubao-lite', 'deepseek-v3'],
    defaultModel: 'doubao-pro',
  },
  {
    key: 'bailian',
    name: 'Aliyun Bailian - 阿里云百炼',
    description: 'Aliyun Bailian Coding Plan',
    providerType: 'anthropic',
    baseUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
    envVar: 'ANTHROPIC_API_KEY',
    models: ['qwen3.5-plus', 'qwen3-coder-plus', 'kimi-k2.5', 'glm-5'],
    defaultModel: 'qwen3.5-plus',
  },
  {
    key: 'ollama',
    name: 'Ollama',
    description: 'Run local models',
    providerType: 'anthropic',
    baseUrl: 'http://localhost:11434',
    envVar: 'ANTHROPIC_AUTH_TOKEN',
    models: ['llama3', 'llama3.1', 'mistral', 'codellama'],
    defaultModel: 'llama3',
    extraEnv: { ANTHROPIC_AUTH_TOKEN: 'ollama' },
  },
  {
    key: 'custom',
    name: 'Custom Endpoint',
    description: 'OpenAI-compatible or Anthropic-compatible API',
    providerType: 'anthropic',
    baseUrl: '',
    envVar: 'ANTHROPIC_API_KEY',
    models: [],
    defaultModel: '',
  },
];

// Print helpers
function printHeader(title: string): void {
  console.log();
  console.log(color(`>> ${title}`, Colors.CYAN));
}

function printInfo(text: string): void {
  console.log(color(`  ${text}`, Colors.DIM));
}

function printSuccess(text: string): void {
  console.log(color(`[OK] ${text}`, Colors.GREEN));
}

function printWarning(text: string): void {
  console.log(color(`[!] ${text}`, Colors.YELLOW));
}

function printError(text: string): void {
  console.log(color(`[ERR] ${text}`, Colors.RED));
}

// Section 1: Model & Provider
async function setupModelProvider(): Promise<void> {
  printHeader('Model & Provider');
  printInfo('Choose your AI provider and configure API access.');
  console.log();

  // Show existing providers
  const existingProviders = getAllCliProviders();
  const activeProvider = getActiveCliProvider();

  if (existingProviders.length > 0) {
    printInfo('Existing providers:');
    for (const p of existingProviders) {
      const isActive = p.id === activeProvider?.id ? ' [ACTIVE]' : '';
      const hasKey = p.api_key ? ` (${maskApiKey(p.api_key)})` : ' (no key)';
      console.log(`  ${p.name}${isActive}${hasKey}`);
    }
    console.log();

    const action = await promptSelect({
      message: 'What would you like to do?',
      choices: [
        { value: 'add', name: 'Add new provider' },
        { value: 'edit', name: 'Edit existing provider' },
        { value: 'activate', name: 'Switch active provider' },
        { value: 'delete', name: 'Delete a provider' },
        { value: 'skip', name: 'Skip (keep current)' },
      ],
      default: existingProviders.length === 0 ? 'add' : 'skip',
    });

    if (action === 'skip') {
      return;
    } else if (action === 'edit') {
      await editExistingProvider(existingProviders);
      return;
    } else if (action === 'activate') {
      await switchActiveProvider(existingProviders);
      return;
    } else if (action === 'delete') {
      await deleteExistingProvider(existingProviders);
      return;
    }
    // action === 'add' continues below
  }

  // Add new provider
  const presetChoices = PROVIDER_PRESETS.map(p => ({
    value: p.key,
    name: `${p.name} - ${p.description}`,
  }));

  const selectedKey = await promptSelect({
    message: 'Select a provider preset:',
    choices: presetChoices,
    default: 'anthropic-official',
  });

  const preset = PROVIDER_PRESETS.find(p => p.key === selectedKey)!;

  // Get API key
  printInfo(`\nConfiguring ${preset.name}`);
  const apiKey = await promptSecret({
    message: `Enter your API key for ${preset.name}:`,
    required: true,
  });

  // Get base URL (for custom or if user wants to override)
  let baseUrl = preset.baseUrl;
  if (selectedKey === 'custom') {
    baseUrl = await promptText({
      message: 'API base URL:',
      required: true,
    });
  } else {
    const overrideUrl = await promptConfirm({
      message: 'Use a custom base URL?',
      default: false,
    });
    if (overrideUrl) {
      baseUrl = await promptText({
        message: 'Custom base URL:',
        default: preset.baseUrl,
      });
    }
  }

  // Select model
  let defaultModel = preset.defaultModel;
  if (preset.models.length > 0) {
    const modelChoices = preset.models.map(m => ({ value: m, name: m }));
    defaultModel = await promptSelect({
      message: 'Select default model:',
      choices: modelChoices,
      default: preset.defaultModel,
    });
  } else {
    defaultModel = await promptText({
      message: 'Default model name:',
      default: preset.defaultModel,
      required: true,
    });
  }

  // Create provider
  const provider = upsertCliProvider({
    name: preset.name,
    providerType: preset.providerType,
    baseUrl,
    apiKey,
    isActive: true,
    extraEnv: preset.extraEnv,
    protocol: preset.providerType,
    notes: `Default model: ${defaultModel}`,
  });

  // Activate this provider (deactivates others)
  activateCliProvider(provider.id);

  // Save default model to settings
  setCliSetting('default_model', defaultModel);

  printSuccess(`Provider "${preset.name}" configured and activated!`);
}

async function editExistingProvider(providers: CliProvider[]): Promise<void> {
  const choices = providers.map(p => ({
    value: p.id,
    name: `${p.name} (${maskApiKey(p.api_key)})`,
  }));

  const providerId = await promptSelect({
    message: 'Select provider to edit:',
    choices,
  });

  const provider = providers.find(p => p.id === providerId)!;

  const newName = await promptText({
    message: 'Provider name:',
    default: provider.name,
  });

  const newApiKey = await promptSecret({
    message: 'API key (leave empty to keep current):',
  });

  const newBaseUrl = await promptText({
    message: 'Base URL:',
    default: provider.base_url,
  });

  upsertCliProvider({
    id: provider.id,
    name: newName,
    providerType: provider.provider_type,
    baseUrl: newBaseUrl,
    apiKey: newApiKey || provider.api_key,
    isActive: provider.is_active === 1,
  });

  printSuccess(`Provider "${newName}" updated!`);
}

async function switchActiveProvider(providers: CliProvider[]): Promise<void> {
  const choices = providers.map(p => ({
    value: p.id,
    name: p.name,
  }));

  const providerId = await promptSelect({
    message: 'Select provider to activate:',
    choices,
  });

  const provider = activateCliProvider(providerId);
  if (provider) {
    printSuccess(`Activated: ${provider.name}`);
  }
}

async function deleteExistingProvider(providers: CliProvider[]): Promise<void> {
  const choices = providers.map(p => ({
    value: p.id,
    name: p.name,
  }));

  const providerId = await promptSelect({
    message: 'Select provider to delete:',
    choices,
  });

  const confirm = await promptConfirm({
    message: 'Are you sure you want to delete this provider?',
    default: false,
  });

  if (confirm) {
    const success = deleteCliProvider(providerId);
    if (success) {
      printSuccess('Provider deleted!');
    }
  }
}

// Section 2: Agent Settings
async function setupAgentSettings(): Promise<void> {
  printHeader('Agent Settings');
  printInfo('Configure agent behavior and limits.');
  console.log();

  // Max iterations
  const currentMaxTurns = getCliSetting('max_turns') || '90';
  const maxTurnsStr = await promptText({
    message: 'Maximum tool-calling iterations per conversation:',
    default: currentMaxTurns,
  });
  const maxTurns = parseInt(maxTurnsStr, 10) || 90;
  setCliSetting('max_turns', String(maxTurns));
  printSuccess(`Max iterations set to ${maxTurns}`);

  // Working mode
  const currentMode = getCliSetting('agent_mode') || 'code';
  const mode = await promptSelect({
    message: 'Default agent mode:',
    choices: [
      { value: 'code', name: 'Code - Full tool access, can modify files' },
      { value: 'plan', name: 'Plan - Read-only, plans changes for you to approve' },
      { value: 'ask', name: 'Ask - No tools, just answers questions' },
    ],
    default: currentMode,
  });
  setCliSetting('agent_mode', mode);
  printSuccess(`Default mode set to: ${mode}`);

  // Permission profile
  const currentProfile = getCliSetting('permission_profile') || 'default';
  const profile = await promptSelect({
    message: 'Permission profile:',
    choices: [
      { value: 'default', name: 'Default - Ask for permission on destructive actions' },
      { value: 'acceptEdits', name: 'Accept Edits - Auto-accept file modifications' },
      { value: 'bypassPermissions', name: 'Bypass - Auto-accept all tool calls (dangerous)' },
      { value: 'dontAsk', name: "Don't Ask - Read-only mode" },
    ],
    default: currentProfile,
  });
  setCliSetting('permission_profile', profile);
  printSuccess(`Permission profile set to: ${profile}`);

  // Tool display mode
  console.log();
  const currentDisplayMode = getCliSetting('tool_display_mode') || 'verbose';
  const displayMode = await promptSelect({
    message: 'Tool call display mode:',
    choices: [
      { value: 'verbose', name: 'Verbose - Show full tool arguments and results' },
      { value: 'compact', name: 'Compact - Show tool name, result summary, and thinking only' },
    ],
    default: currentDisplayMode,
  });
  setCliSetting('tool_display_mode', displayMode);
  printSuccess(`Tool display mode set to: ${displayMode}`);
}

// Section 3: MCP Servers
async function setupMCPServers(): Promise<void> {
  printHeader('MCP Servers');
  printInfo('Model Context Protocol servers extend agent capabilities.');
  console.log();

  const currentServers = getCliSettingJson<Array<{ name: string; command: string; args?: string[] }>>('mcp_servers', []);

  if (currentServers.length > 0) {
    printInfo('Configured MCP servers:');
    for (const s of currentServers) {
      console.log(`  - ${s.name}: ${s.command}`);
    }
    console.log();
  }

  const action = await promptSelect({
    message: 'What would you like to do?',
    choices: [
      { value: 'add', name: 'Add new MCP server' },
      { value: 'remove', name: 'Remove MCP server' },
      { value: 'skip', name: 'Skip' },
    ],
    default: 'skip',
  });

  if (action === 'skip') {
    return;
  } else if (action === 'remove') {
    if (currentServers.length === 0) {
      printInfo('No MCP servers to remove.');
      return;
    }
    const choices = currentServers.map((s, i) => ({
      value: String(i),
      name: `${s.name}: ${s.command}`,
    }));
    const idx = await promptSelect({
      message: 'Select server to remove:',
      choices,
    });
    currentServers.splice(parseInt(idx, 10), 1);
    setCliSettingJson('mcp_servers', currentServers);
    printSuccess('MCP server removed!');
    return;
  }

  // Add new server
  let addMore = true;
  while (addMore) {
    const name = await promptText({
      message: 'MCP server name:',
      required: true,
    });

    const command = await promptText({
      message: 'Command to run:',
      required: true,
    });

    const argsStr = await promptText({
      message: 'Arguments (comma-separated, optional):',
    });

    currentServers.push({
      name,
      command,
      args: argsStr ? argsStr.split(',').map(a => a.trim()) : undefined,
    });

    printSuccess(`MCP server "${name}" added`);

    addMore = await promptConfirm({
      message: 'Add another MCP server?',
      default: false,
    });
  }

  setCliSettingJson('mcp_servers', currentServers);
}

// Print setup summary
function printSetupSummary(): void {
  const providers = getAllCliProviders();
  const activeProvider = getActiveCliProvider();
  const mcpServers = getCliSettingJson('mcp_servers', []);

  console.log();
  console.log(color('============================================================', Colors.GREEN));
  console.log(color('              Setup Complete!                               ', Colors.GREEN));
  console.log(color('============================================================', Colors.GREEN));
  console.log();

  // Providers
  if (providers.length > 0) {
    console.log(color('Configured Providers:', Colors.YELLOW));
    for (const p of providers) {
      const isActive = p.id === activeProvider?.id ? ' [ACTIVE]' : '';
      console.log(`  ${p.name}${isActive}`);
    }
    console.log();
  }

  // Settings
  const maxTurns = getCliSetting('max_turns') || '90';
  const mode = getCliSetting('agent_mode') || 'code';
  const displayMode = getCliSetting('tool_display_mode') || 'verbose';
  console.log(color('Agent Settings:', Colors.YELLOW));
  console.log(`  Max iterations: ${maxTurns}`);
  console.log(`  Default mode: ${mode}`);
  console.log(`  Tool display: ${displayMode}`);
  console.log();

  // MCP
  if (mcpServers.length > 0) {
    console.log(color('MCP Servers:', Colors.YELLOW) + ` ${mcpServers.length}`);
    for (const s of mcpServers as Array<{ name: string }>) {
      console.log(`  - ${s.name}`);
    }
    console.log();
  }

  console.log(color('------------------------------------------------------------', Colors.DIM));
  console.log();
  console.log(bold(color('Ready to go!', Colors.CYAN)));
  console.log();
  console.log(color('duya', Colors.GREEN) + '              Start chatting');
  console.log(color('duya setup', Colors.GREEN) + '           Re-run setup wizard');
  console.log(color('duya setup model', Colors.GREEN) + '     Configure providers');
  console.log(color('duya setup agent', Colors.GREEN) + '     Configure agent settings');
  console.log();
}

// Main entry point
export async function runSetupWizard(section?: string): Promise<void> {
  // Initialize database
  initCliDatabase();

  // Handle specific section
  if (section) {
    switch (section) {
      case 'model':
      case 'provider':
        await setupModelProvider();
        break;
      case 'agent':
        await setupAgentSettings();
        break;
      case 'mcp':
        await setupMCPServers();
        break;
      default:
        printError(`Unknown setup section: ${section}`);
        printInfo('Available sections: model, agent, mcp');
        return;
    }
    printSuccess(`${section} configuration complete!`);
    return;
  }

  // Welcome banner
  console.log();
  console.log(color('============================================================', Colors.MAGENTA));
  console.log(color('              DUYA Agent Setup Wizard                       ', Colors.MAGENTA));
  console.log(color('============================================================', Colors.MAGENTA));
  console.log(color('  Let\'s configure your DUYA Agent installation.', Colors.MAGENTA));
  console.log(color('  Press Ctrl+C at any time to exit.', Colors.MAGENTA));
  console.log(color('  Use Up/Down arrows to navigate, Enter to select.', Colors.MAGENTA));
  console.log(color('============================================================', Colors.MAGENTA));
  console.log();

  // Check if existing installation
  const providers = getAllCliProviders();
  const hasProvider = providers.length > 0;

  if (hasProvider) {
    // Returning user menu
    printSuccess(`You have ${providers.length} provider(s) configured.`);
    console.log();

    const menuChoices = [
      { value: 'quick', name: 'Quick Setup - review and update' },
      { value: 'full', name: 'Full Setup - reconfigure everything' },
      { value: 'model', name: 'Model & Provider' },
      { value: 'agent', name: 'Agent Settings' },
      { value: 'mcp', name: 'MCP Servers' },
      { value: 'exit', name: 'Exit' },
    ];

    const choice = await promptSelect({
      message: 'What would you like to do?',
      choices: menuChoices,
      default: 'quick',
    });

    if (choice === 'exit') {
      printInfo('Exiting. Run "duya setup" again when ready.');
      return;
    } else if (choice === 'quick') {
      await setupModelProvider();
      await setupAgentSettings();
      printSetupSummary();
      return;
    } else if (choice === 'full') {
      // Continue to full setup
    } else {
      await runSetupWizard(choice);
      return;
    }
  }

  // Full setup for new users
  await setupModelProvider();
  await setupAgentSettings();
  await setupMCPServers();

  printSetupSummary();
}

export default {
  runSetupWizard,
};
