/**
 * Per-platform display/verbosity configuration resolver.
 *
 * Ported from hermes-agent gateway/display_config.py.
 *
 * Resolution order (first non-null wins):
 *   1. Per-platform overrides
 *   2. Global display settings
 *   3. Built-in platform defaults (tiered by capability)
 *   4. Built-in global defaults
 *
 * Tier system:
 *   Tier 1 (high): Full edit support — telegram, discord
 *   Tier 2 (medium): Edit support, often workspace — slack, feishu
 *   Tier 3 (low): No edit support — weixin, signal
 *   Tier 4 (minimal): Batch/non-interactive — email, sms
 */

import type { PlatformType } from './types.js';

// ---------------------------------------------------------------------------
// Display settings type
// ---------------------------------------------------------------------------

export interface DisplayConfig {
  /** Tool progress visibility: 'all' | 'new' | 'off' */
  toolProgress: 'all' | 'new' | 'off';
  /** Show reasoning/thinking blocks */
  showReasoning: boolean;
  /** Max characters for tool input preview (0 = disabled) */
  toolPreviewLength: number;
  /** Enable token-level streaming */
  streaming: boolean | null;
}

// ---------------------------------------------------------------------------
// Per-platform overrides from user config
// ---------------------------------------------------------------------------

export interface DisplayOverrides {
  toolProgress?: 'all' | 'new' | 'off';
  showReasoning?: boolean;
  toolPreviewLength?: number;
  streaming?: boolean;
}

export interface DisplayUserConfig {
  toolProgress?: 'all' | 'new' | 'off';
  showReasoning?: boolean;
  toolPreviewLength?: number;
  streaming?: boolean | null;
  platforms?: Partial<Record<PlatformType, DisplayOverrides>>;
}

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------

const GLOBAL_DEFAULTS: DisplayConfig = {
  toolProgress: 'all',
  showReasoning: false,
  toolPreviewLength: 0,
  streaming: null,
};

// ---------------------------------------------------------------------------
// Tiered defaults
// ---------------------------------------------------------------------------

const TIER_HIGH: DisplayConfig = {
  toolProgress: 'all',
  showReasoning: false,
  toolPreviewLength: 40,
  streaming: null,
};

const TIER_MEDIUM: DisplayConfig = {
  toolProgress: 'new',
  showReasoning: false,
  toolPreviewLength: 40,
  streaming: null,
};

const TIER_LOW: DisplayConfig = {
  toolProgress: 'off',
  showReasoning: false,
  toolPreviewLength: 40,
  streaming: false,
};

const TIER_MINIMAL: DisplayConfig = {
  toolProgress: 'off',
  showReasoning: false,
  toolPreviewLength: 0,
  streaming: false,
};

const PLATFORM_DEFAULTS: Record<PlatformType, DisplayConfig> = {
  telegram:     TIER_HIGH,
  discord:       TIER_HIGH,
  feishu:        TIER_MEDIUM,
  whatsapp:      TIER_MEDIUM,
  weixin:        TIER_LOW,
  qq:            TIER_LOW,
};

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

export function resolveDisplayConfig(
  platform: PlatformType,
  userConfig?: DisplayUserConfig,
): DisplayConfig {
  const platDefaults = PLATFORM_DEFAULTS[platform] ?? TIER_MEDIUM;

  if (!userConfig) return { ...platDefaults };

  const platformOverrides = userConfig.platforms?.[platform];

  return {
    toolProgress:
      platformOverrides?.toolProgress ??
      userConfig.toolProgress ??
      platDefaults.toolProgress,
    showReasoning:
      platformOverrides?.showReasoning ??
      userConfig.showReasoning ??
      platDefaults.showReasoning,
    toolPreviewLength:
      platformOverrides?.toolPreviewLength ??
      userConfig.toolPreviewLength ??
      platDefaults.toolPreviewLength,
    streaming:
      platformOverrides?.streaming ??
      userConfig.streaming ??
      platDefaults.streaming,
  };
}

export function resolveDisplaySetting<K extends keyof DisplayConfig>(
  platform: PlatformType,
  setting: K,
  userConfig?: DisplayUserConfig,
): DisplayConfig[K] {
  const config = resolveDisplayConfig(platform, userConfig);
  return config[setting];
}

/** Check if a platform supports message editing based on display tier */
export function supportsStreamingEdit(platform: PlatformType): boolean {
  const platDefaults = PLATFORM_DEFAULTS[platform] ?? TIER_MEDIUM;
  return platDefaults.streaming !== false;
}

/** Check if a platform should show tool progress */
export function showToolProgress(
  platform: PlatformType,
  userConfig?: DisplayUserConfig,
): 'all' | 'new' | 'off' {
  return resolveDisplaySetting(platform, 'toolProgress', userConfig);
}