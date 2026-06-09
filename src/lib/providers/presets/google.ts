/**
 * src/lib/providers/presets/google.ts
 *
 * Google Gemini / Vertex presets. Vertex is included as a separate
 * `apiFormat` so it can later be wired to a real GCP SDK without
 * touching the rest of the codebase.
 */

import type { ProviderPreset } from '../types';

const GEMINI_AUTH_FIELDS = [
  { key: 'api_key', label: 'API Key', secret: true, required: true },
];

export const GOOGLE_PRESETS: ProviderPreset[] = [
  {
    key: 'google-gemini',
    name: 'Google Gemini',
    description: "Google's Gemini API (Developer API)",
    descriptionZh: 'Google Gemini API（开发者 API）',
    category: 'official',
    apiFormat: 'gemini',
    authFields: GEMINI_AUTH_FIELDS,
    defaultEndpoint: 'https://generativelanguage.googleapis.com',
    modelsSource: { type: 'openai-compatible-models', path: '/v1beta/models' },
    defaultModels: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-pro'],
    ui: {
      icon: 'google',
      iconColor: '#4285F4',
      websiteUrl: 'https://aistudio.google.com',
      apiKeyUrl: 'https://aistudio.google.com/apikey',
    },
    legacyProtocol: 'google',
  },
  {
    key: 'google-vertex',
    name: 'Google Vertex AI',
    description: 'Google Vertex AI — Claude / Gemini / Imagen models',
    descriptionZh: 'Google Vertex AI — Claude / Gemini / Imagen 模型',
    category: 'managed',
    apiFormat: 'vertex',
    authFields: [
      { key: 'api_key', label: 'Bearer Token', secret: true, required: true },
    ],
    defaultEndpoint: 'https://us-central1-aiplatform.googleapis.com',
    modelsSource: { type: 'static' },
    defaultModels: ['claude-sonnet-4-5@20251001', 'gemini-2.5-pro'],
    ui: {
      icon: 'google',
      iconColor: '#4285F4',
      websiteUrl: 'https://cloud.google.com/vertex-ai',
    },
    legacyProtocol: 'vertex',
  },
];
