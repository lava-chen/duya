/**
 * src/components/settings/forms/hooks/useApiKeyLink.ts
 *
 * Plan 203 Phase 4.2: derive the "Get API key" + docs URLs from a
 * preset, and a `openApiKeyLink` callback that delegates to
 * `useOpenExternal`. Used by `ProviderConnectDialog` to render
 * the "Where do I get an API key?" link.
 *
 * Why a hook:
 * - The preset can be either a `ProviderPreset` (new domain) or
 *   a `QuickPreset` (legacy). The hook normalizes both into the
 *   same `apiKeyUrl` / `docsUrl` shape.
 * - The hook is presentation-agnostic; the dialog decides how to
 *   render the link.
 *
 * URL safety:
 * - The `apiKeyUrl` is taken verbatim from the preset's `ui.apiKeyUrl`.
 *   If that field is missing or empty, the hook returns `null`
 *   and the dialog renders no link.
 * - The actual `open` call goes through `useOpenExternal`, which
 *   enforces the `https:`-only filter. The hook does NOT need to
 *   re-validate.
 */

import { useCallback, useMemo } from 'react';
import { useOpenExternal } from '@/lib/providers/hooks/useOpenExternal';
import type { ProviderPreset } from '@/lib/providers';
import type { QuickPreset } from '@/lib/provider-presets';

export interface UseApiKeyLinkOptions {
  /** The current preset, or `null` if none selected. */
  preset: ProviderPreset | QuickPreset | null;
}

export interface ApiKeyLink {
  apiKeyUrl: string | null;
  docsUrl: string | null;
  openApiKeyLink: () => void;
}

function isQuickPreset(p: ProviderPreset | QuickPreset): p is QuickPreset {
  return 'provider_type' in p && 'fields' in p;
}

export function useApiKeyLink({ preset }: UseApiKeyLinkOptions): ApiKeyLink {
  const openExternal = useOpenExternal();

  const apiKeyUrl = useMemo<string | null>(() => {
    if (!preset) return null;
    if (isQuickPreset(preset)) {
      // The legacy `QuickPreset` has no dedicated `apiKeyUrl`
      // field. We fall back to the preset's `meta.docsUrl` (which
      // is typically a vendor dashboard link).
      return preset.meta?.docsUrl ?? null;
    }
    return preset.ui?.apiKeyUrl ?? null;
  }, [preset]);

  const docsUrl = useMemo<string | null>(() => {
    if (!preset) return null;
    if (isQuickPreset(preset)) return preset.meta?.docsUrl ?? null;
    return preset.ui?.docsUrl ?? null;
  }, [preset]);

  const openApiKeyLink = useCallback(() => {
    if (apiKeyUrl) openExternal(apiKeyUrl);
  }, [apiKeyUrl, openExternal]);

  return { apiKeyUrl, docsUrl, openApiKeyLink };
}
