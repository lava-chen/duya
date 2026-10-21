/**
 * Provider commands for CLI
 *
 * Implements provider list, add, remove functionality
 */

import { Colors, color } from './colors.js'
import { selectFromList, prompt, promptPassword, printSuccess, printError, printHeader, printInfo } from './interactive.js'

// Provider interfaces
export interface ProviderConfig {
  id: string
  name: string
  type: 'anthropic' | 'openai' | 'azure' | 'ollama'
  apiKey?: string
  baseURL?: string
  defaultModel?: string
}

/**
 * Display list of configured providers
 */
export async function listProviders(providers: ProviderConfig[]): Promise<void> {
  if (providers.length === 0) {
    console.log(color('  No providers configured', Colors.DIM))
    console.log(color('  Run "duya provider add" to add one', Colors.DIM))
    return
  }

  printHeader('Configured Providers')

  providers.forEach((provider, index) => {
    const num = String(index + 1).padStart(2, ' ')
    const name = color(provider.name, Colors.BRIGHT_CYAN)
    const type = color(`[${provider.type}]`, Colors.DIM)
    const model = provider.defaultModel
      ? color(` - ${provider.defaultModel}`, Colors.DIM)
      : ''

    console.log(color(`  ${num}. ${name} ${type}${model}`, Colors.WHITE))
  })
  console.log('')
}

/**
 * Interactive provider addition flow
 */
export async function addProviderInteractive(): Promise<Partial<ProviderConfig> | null> {
  printHeader('Add New Provider')

  // Step 1: Select provider type
  const providerTypes = [
    { id: 'anthropic', name: 'Anthropic (Claude)', models: ['claude-opus-4-20250514', 'claude-sonnet-4-20250514', 'claude-haiku-4-20250514'] },
    { id: 'openai', name: 'OpenAI (GPT)', models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'] },
    { id: 'azure', name: 'Azure OpenAI', models: ['gpt-4', 'gpt-35-turbo'] },
    { id: 'ollama', name: 'Ollama (local)', models: ['llama3', 'codellama', 'mistral'] },
  ]

  const typeResult = await selectFromList(
    'Select provider type',
    providerTypes,
    (p) => p.name
  )

  if (!typeResult) {
    printError('Provider addition cancelled')
    return null
  }

  const selectedType = typeResult.selected
  console.log(color(`  Selected: ${selectedType.name}`, Colors.GREEN))

  // Step 2: Enter API Key
  const apiKey = await promptPassword('Enter API Key')
  if (!apiKey || apiKey.length < 10) {
    printError('Invalid API key')
    return null
  }

  // Step 3: Enter Base URL (optional)
  const baseURL = await prompt('Base URL (optional, press Enter to skip')
  const baseURLValue = baseURL || undefined

  // Step 4: Select default model
  const modelResult = await selectFromList(
    'Select default model',
    selectedType.models,
    (m) => m
  )

  const model = modelResult?.selected || selectedType.models[0]

  // Return the config
  const config: Partial<ProviderConfig> = {
    type: selectedType.id as ProviderConfig['type'],
    apiKey,
    baseURL: baseURLValue,
    defaultModel: model,
  }

  return config
}

/**
 * Confirm provider removal
 */
export async function confirmRemove(provider: ProviderConfig): Promise<boolean> {
  console.log('')
  printInfo(`Provider: ${provider.name} (${provider.type})`)
  if (provider.defaultModel) {
    printInfo(`Model: ${provider.defaultModel}`)
  }
  console.log('')

  const { promptYesNo } = await import('./interactive.js')
  return promptYesNo('Remove this provider?', false)
}

export default {
  listProviders,
  addProviderInteractive,
  confirmRemove,
}