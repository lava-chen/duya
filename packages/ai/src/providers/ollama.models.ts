// Model data. Hand-curated — a local runtime has no upstream catalogue.
//
// The provider lists the models actually installed from /api/tags, so this
// file is only the fallback seed for a machine where that fetch has not run
// yet. The context windows are the upstream defaults of each model family;
// a local build with a smaller window (or a long context variant) reports its
// real window at runtime.
import type { Model } from '../types.js';

export const ollamaModels: Model<'openai-chat'>[] = [
  {
    id: 'llama3.3',
    name: 'Llama 3.3',
    api: 'openai-chat',
    providerId: 'ollama',
    baseUrl: 'http://localhost:11434/v1',
    reasoning: false,
    input: ['text'],
    contextWindow: 131072,
    maxTokens: 8192,
  },
  {
    id: 'llama3.2',
    name: 'Llama 3.2',
    api: 'openai-chat',
    providerId: 'ollama',
    baseUrl: 'http://localhost:11434/v1',
    reasoning: false,
    input: ['text'],
    contextWindow: 128000,
    maxTokens: 4096,
  },
  {
    id: 'qwen3',
    name: 'Qwen 3',
    api: 'openai-chat',
    providerId: 'ollama',
    baseUrl: 'http://localhost:11434/v1',
    // Whether a local model thinks depends on the Ollama build and on how
    // it is served, so the seed does not claim a thinking format.
    reasoning: false,
    input: ['text'],
    contextWindow: 40960,
    maxTokens: 8192,
  },
  {
    id: 'qwen2.5',
    name: 'Qwen 2.5',
    api: 'openai-chat',
    providerId: 'ollama',
    baseUrl: 'http://localhost:11434/v1',
    reasoning: false,
    input: ['text'],
    contextWindow: 32768,
    maxTokens: 8192,
  },
  {
    id: 'gemma3',
    name: 'Gemma 3',
    api: 'openai-chat',
    providerId: 'ollama',
    baseUrl: 'http://localhost:11434/v1',
    reasoning: false,
    input: ['text', 'image'],
    contextWindow: 131072,
    maxTokens: 8192,
  },
  {
    id: 'mistral',
    name: 'Mistral',
    api: 'openai-chat',
    providerId: 'ollama',
    baseUrl: 'http://localhost:11434/v1',
    reasoning: false,
    input: ['text'],
    contextWindow: 32768,
    maxTokens: 8192,
  },
  {
    id: 'codellama',
    name: 'CodeLlama',
    api: 'openai-chat',
    providerId: 'ollama',
    baseUrl: 'http://localhost:11434/v1',
    reasoning: false,
    input: ['text'],
    contextWindow: 16384,
    maxTokens: 4096,
  },
  {
    id: 'deepseek-coder',
    name: 'DeepSeek Coder',
    api: 'openai-chat',
    providerId: 'ollama',
    baseUrl: 'http://localhost:11434/v1',
    reasoning: false,
    input: ['text'],
    contextWindow: 16384,
    maxTokens: 4096,
  },
];
