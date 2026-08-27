import type { Model } from '../types.js';
import { createProvider } from './create-provider.js';
import { envApiKeyAuth } from '../auth/helpers.js';
import { googleGenerativeAiStreams } from './adapters.js';

/**
 * Google GenerativeLanguage provider (Plan 451 Phase 4).
 *
 * Direct `fetch`-based Gemini client (no Google SDK). Authentication via
 * `GEMINI_API_KEY` env var, passed as `x-goog-api-key` header on every
 * request. Endpoint defaults to
 * `https://generativelanguage.googleapis.com/v1beta`.
 *
 * Model catalog intentionally empty for Phase 4 MVP — populate via the
 * same `.models.ts` pattern as other providers (Phase 8 e2e validation).
 */
export const google = createProvider<'gemini'>({
  id: 'google',
  name: 'Google Generative AI',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  auth: envApiKeyAuth('GEMINI_API_KEY', ['GEMINI_API_KEY', 'GOOGLE_API_KEY']),
  models: [] as Model<'gemini'>[],
  api: googleGenerativeAiStreams({
    apiKey: '',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta',
    model: '',
    apiFormat: 'gemini',
    providerId: 'google',
  }),
});