import type { AuthResult, Credential, CredentialStore } from './types.js';
import type { EnvResolver } from './helpers.js';

export interface AuthResolutionOverrides {
  apiKey?: string;
  env?: Record<string, string>;
}

interface ResolvableAuth {
  apiKey?: {
    resolve(ctx: EnvResolver): Promise<AuthResult | undefined>;
  };
  oauth?: {
    toAuth?(credential: Credential): Promise<AuthResult>;
  };
}

const envFromOverrides = (overrides: Record<string, string>): EnvResolver => ({
  env: async (name) => overrides[name],
});

/**
 * Resolve provider auth in priority order:
 * 1. Stored OAuth credential (converted to a request auth via oauth.toAuth).
 * 2. Explicit apiKey override.
 * 3. Env-var API key resolution.
 * Returns undefined when no auth is available; throws ModelsError('auth') when
 * the provider requires auth but none could be resolved.
 */
export async function resolveProviderAuth(
  provider: { id: string; auth: ResolvableAuth; requiresAuth?: boolean },
  store: CredentialStore,
  ctx: EnvResolver,
  overrides?: AuthResolutionOverrides,
): Promise<AuthResult | undefined> {
  const stored = await store.get(provider.id);
  if (stored?.type === 'oauth' && provider.auth.oauth?.toAuth) {
    return provider.auth.oauth.toAuth(stored);
  }

  if (overrides?.apiKey) {
    return { auth: { apiKey: overrides.apiKey }, source: 'override' };
  }

  if (provider.auth.apiKey) {
    const result = await provider.auth.apiKey.resolve(
      overrides?.env ? envFromOverrides(overrides.env) : ctx,
    );
    if (result) return result;
  }

  if (provider.requiresAuth) {
    throw new Error(
      `Provider ${provider.id} requires authentication but no credentials were found`,
    );
  }
  return undefined;
}