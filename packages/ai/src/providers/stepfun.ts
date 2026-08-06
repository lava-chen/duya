import type { Model } from '../types.js';
import { createProvider } from './create-provider.js';
import { envApiKeyAuth } from '../auth/helpers.js';
import { stepfunModels } from './stepfun.models.js';
import { anthropicStreams } from './adapters.js';

export const stepfun = createProvider({
  id: 'stepfun',
  name: 'StepFun',
  baseUrl: 'https://api.stepfun.ai/step_plan/v1',
  auth: envApiKeyAuth('StepFun API Key', ['STEPFUN_API_KEY']),
  models: stepfunModels,
  api: anthropicStreams({ apiKey: '', baseURL: 'https://api.stepfun.ai/step_plan/v1', model: '', apiFormat: 'anthropic', providerId: 'stepfun' }),
});