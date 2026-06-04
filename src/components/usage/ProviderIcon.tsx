"use client";

import React from "react";
import { findPresetByBaseUrl } from "@/lib/provider-presets";
import { PresetIcon } from "@/components/settings/PresetIcon";

interface ProviderIconProps {
  providerType: string;
  baseUrl?: string | null;
  size?: number;
}

/**
 * Resolve the brand icon for a provider by detecting preset from baseUrl
 * or falling back to a generic server icon.
 */
export function ProviderIcon({ providerType, baseUrl, size = 20 }: ProviderIconProps) {
  const preset = baseUrl ? findPresetByBaseUrl(baseUrl) : undefined;
  if (preset) {
    return <PresetIcon iconKey={preset.iconKey} size={size} />;
  }

  const url = (baseUrl || "").toLowerCase();
  if (providerType === "openrouter") {
    return <PresetIcon iconKey="openrouter" size={size} />;
  }
  if (providerType === "ollama" || url.includes("ollama") || url.includes("11434")) {
    return <PresetIcon iconKey="ollama" size={size} />;
  }
  if (providerType === "bedrock" || url.includes("bedrock") || url.includes("aws.amazon")) {
    return <PresetIcon iconKey="bedrock" size={size} />;
  }
  if (providerType === "vertex" || url.includes("vertex") || url.includes("google")) {
    return <PresetIcon iconKey="google" size={size} />;
  }
  if (url.includes("anthropic")) {
    return <PresetIcon iconKey="anthropic" size={size} />;
  }
  return <PresetIcon iconKey="server" size={size} />;
}
