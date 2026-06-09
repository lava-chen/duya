/**
 * src/lib/providers/presets/ollama.ts
 *
 * Ollama local runtime preset. apiFormat 'ollama', auth 'none'.
 *
 * Models are listed from /api/tags. The preset's defaultModels are
 * a static fallback for offline UI.
 */

import type { ProviderPreset } from '../types';

export const OLLAMA_PRESETS: ProviderPreset[] = [
  {
    key: 'ollama',
    name: 'Ollama',
    description: 'Ollama — run local models with native API',
    descriptionZh: 'Ollama — 本地运行模型，原生 API',
    category: 'local',
    apiFormat: 'ollama',
    authFields: [
      // No secret: ollama runs unauthenticated locally.
      { key: 'base_url', label: 'Base URL', secret: false, required: true },
    ],
    defaultEndpoint: 'http://localhost:11434',
    endpointCandidates: [
      'http://localhost:11434',
      'http://127.0.0.1:11434',
    ],
    modelsSource: { type: 'custom-url', url: '/api/tags' },
    defaultModels: ['llama3.2', 'qwen2.5', 'codellama', 'mistral', 'deepseek-coder'],
    defaultModelLabels: {
      'llama3.2': 'Llama 3.2',
      'qwen2.5': 'Qwen 2.5',
      'codellama': 'CodeLlama',
      'mistral': 'Mistral',
      'deepseek-coder': 'DeepSeek Coder',
    },
    templateValues: { OPENAI_API_KEY: 'ollama' },
    ui: {
      icon: 'ollama',
      websiteUrl: 'https://ollama.com',
      docsUrl: 'https://github.com/ollama/ollama/blob/main/docs/api.md',
    },
    legacyProtocol: 'ollama',
  },
];
