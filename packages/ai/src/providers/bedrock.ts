import type { Model } from '../types.js';
import { createProvider } from './create-provider.js';
import { envApiKeyAuth } from '../auth/helpers.js';
import { bedrockConverseStreams } from './adapters.js';

/**
 * Bedrock Converse provider (Plan 451 Phase 3).
 *
 * Authentication uses AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (env
 * resolver). The `bedrockConverseStreams` adapter reads credentials from
 * `options.options.awsAccessKeyId / awsSecretAccessKey`; the envApiKeyAuth
 * helper here provides the AWS_ACCESS_KEY_ID half; the secret key is
 * captured by the provider via the auth helper too and threaded through
 * the same env resolver.
 *
 * For a richer credential surface (STS session tokens, IAM roles, profile
 * names) extend the auth resolver in `auth/helpers.ts` and update the
 * adapter — Phase 3 ships the MVP.
 */
export const bedrock = createProvider<'bedrock'>({
  id: 'bedrock',
  name: 'AWS Bedrock',
  baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com',
  auth: envApiKeyAuth('AWS_ACCESS_KEY_ID', ['AWS_ACCESS_KEY_ID']),
  models: [] as Model<'bedrock'>[],
  api: bedrockConverseStreams({
    apiKey: '',
    baseURL: 'https://bedrock-runtime.us-east-1.amazonaws.com',
    model: '',
    apiFormat: 'bedrock',
    providerId: 'bedrock',
  }),
});