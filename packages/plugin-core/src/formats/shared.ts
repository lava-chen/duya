// shared.ts — pure helpers shared by the format adapters. No I/O.

import type { NormalizedAuthor, NormalizedInterface } from './types';

/**
 * Anything that looks like a clone URL rather than a repo-relative path.
 * Covers the schemes seen in the wild plus the `github:` shorthand that
 * Claude Code's marketplace accepts.
 */
export const GIT_URL_LIKE = /^(https?:\/\/|git@|ssh:\/\/|git:\/\/|github:)/;

export function isPlainObject(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw);
}

/** Trimmed non-empty string, else undefined. */
export function asString(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const s = raw.trim();
  return s.length > 0 ? s : undefined;
}

/** Every string element of an array (non-strings dropped); [] when not an array. */
export function asStringArray(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
}

/** First value that resolves to a non-empty string. */
export function firstString(...values: unknown[]): string | undefined {
  for (const v of values) {
    const s = asString(v);
    if (s) return s;
  }
  return undefined;
}

/**
 * Author is an object in duya / Codex (`{name,url,email}`) and occasionally
 * a bare string in hand-written manifests.
 */
export function normalizeAuthor(raw: unknown): NormalizedAuthor {
  if (typeof raw === 'string') {
    const name = asString(raw);
    return name ? { name } : {};
  }
  if (!isPlainObject(raw)) return {};
  const out: NormalizedAuthor = {};
  const name = asString(raw.name);
  if (name) out.name = name;
  const url = asString(raw.url);
  if (url) out.url = url;
  const email = asString(raw.email);
  if (email) out.email = email;
  return out;
}

/**
 * Build the canonical interface block from a raw `interface` object.
 *
 * Tolerant by design (foreign manifests vary):
 *   - icon falls back across `icon` → `composerIcon` → `logo` (Codex uses
 *     the latter two, Claude uses none of them).
 *   - `screenshots` / `defaultPrompt` pass through; the duya-side parser
 *     still applies its own prompt-count and length limits.
 */
export function buildInterfaceBlock(
  raw: unknown,
  iconFallbacks: unknown[] = [],
): NormalizedInterface | undefined {
  if (!isPlainObject(raw)) {
    const icon = firstString(...iconFallbacks);
    return icon ? { icon } : undefined;
  }
  const out: NormalizedInterface = {};
  const displayName = asString(raw.displayName);
  if (displayName) out.displayName = displayName;
  const shortDescription = asString(raw.shortDescription);
  if (shortDescription) out.shortDescription = shortDescription;
  const longDescription = asString(raw.longDescription);
  if (longDescription) out.longDescription = longDescription;
  const category = asString(raw.category);
  if (category) out.category = category;
  const brandColor = asString(raw.brandColor);
  if (brandColor) out.brandColor = brandColor;
  const icon = firstString(raw.icon, raw.composerIcon, raw.logo, ...iconFallbacks);
  if (icon) out.icon = icon;
  const displayNameZh = asString(raw.displayName_zh);
  if (displayNameZh) out.displayName_zh = displayNameZh;
  const shortDescriptionZh = asString(raw.shortDescription_zh);
  if (shortDescriptionZh) out.shortDescription_zh = shortDescriptionZh;
  const screenshots = asStringArray(raw.screenshots);
  if (screenshots.length) out.screenshots = screenshots;
  const defaultPrompt = asStringArray(raw.defaultPrompt);
  if (defaultPrompt.length) out.defaultPrompt = defaultPrompt;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Require a trimmed non-empty `name`, throwing a manifest-shaped error. */
export function requireName(raw: Record<string, unknown>, label: string): string {
  const name = asString(raw.name);
  if (!name) throw new Error(`${label} plugin manifest is missing "name"`);
  return name;
}

/** Default `version` to 0.0.0 — foreign manifests routinely omit it. */
export function normalizeVersion(raw: unknown): string {
  return asString(raw) ?? '0.0.0';
}
