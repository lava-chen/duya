import type { AuthResult, Credential } from './types.js';
import type { ProviderAuthConfig } from '../providers/types.js';

export interface EnvResolver {
  env(name: string): Promise<string | undefined>;
}

/**
 * Build a ProviderAuthConfig that scans a list of env var names and returns
 * the first value found as the API key.
 */
export function envApiKeyAuth(name: string, envNames: string[]): ProviderAuthConfig {
  return {
    apiKey: {
      async resolve(ctx: EnvResolver): Promise<AuthResult | undefined> {
        for (const envName of envNames) {
          const value = await ctx.env(envName);
          if (value) return { auth: { apiKey: value }, source: envName };
        }
        return undefined;
      },
    },
  };
}

/**
 * Lazy OAuth auth. The underlying OAuth module (and its network logic) is
 * loaded only when a login is requested, keeping the bundle free of
 * provider-specific OAuth dependencies.
 */
export function lazyOAuth(input: {
  name: string;
  load(): Promise<{ login(): Promise<Credential> }>;
}) {
  return {
    name: input.name,
    async login(): Promise<Credential> {
      return (await input.load()).login();
    },
  };
}