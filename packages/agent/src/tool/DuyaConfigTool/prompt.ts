import { DUYA_CONFIG_TOOL_NAME } from './constants.js';

export const DESCRIPTION = `Read or modify DUYA configuration. Use this to help the user manage API providers, models, vision settings, and output styles through conversation.

## Available actions

### Reading config
- **providers_list** — List all configured API providers with their status
- **settings_get** — Get current agent settings (model, temperature, maxTokens, etc.)
- **vision_get** — Get current vision model settings
- **style_get** — Get current output style settings

### Managing providers
- **provider_add** — Add or update an API provider. Requires: id, name, providerType, baseUrl?, apiKey, isActive?
- **provider_remove** — Remove a provider by id
- **provider_activate** — Switch active provider by id

### Modifying settings
- **settings_set** — Update agent settings. Allowed fields: model, maxTokens, temperature, topP, topK, enableThinking, thinkingBudget
- **vision_set** — Update vision settings. Allowed fields: provider, model
- **style_set** — Update output style. Allowed fields: styleId

## Security
- API keys are stored encrypted and never returned in full
- Only safe configuration paths are modifiable
- UI preferences and internal feature flags cannot be changed through this tool`;

export function getPrompt(): string {
  return `Tool: ${DUYA_CONFIG_TOOL_NAME} — Manage DUYA configuration`;
}