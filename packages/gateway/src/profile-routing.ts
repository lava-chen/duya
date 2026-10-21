/**
 * ProfileRouting - Route inbound IM sources to a designated agent profile.
 *
 * A single DUYA gateway can front multiple channels/groups/threads. Profile
 * routing lets each (platform, chatId) — and optionally a thread — resolve to a
 * distinct agent profile (own model, tools, memory, persona) instead of every
 * inbound message sharing the default gateway profile.
 *
 * Matching is hierarchical, most-specific-first:
 *   1. platform + chat_id + thread_id  (exact thread)     — specificity 8
 *   2. platform + chat_id              (channel route)    — specificity 4
 *   3. platform only                   (platform default) — specificity 0
 *   4. No match                                          → default profile
 *
 * This is the "basic version": it resolves a profile name for an inbound
 * message. The name is carried to the Main process so the worker can be
 * configured with that profile. Higher-level profile resolution (model, tool
 * set, memory) lives in the agent core, not here.
 */

import type { PlatformType } from './types.js';

export interface ProfileRoute {
  /** Stable identifier for the route (logging/diagnostics). */
  name: string;
  platform: PlatformType;
  /** Resolved profile name to route to. */
  profile: string;
  chatId?: string;
  threadId?: string;
  enabled?: boolean;
}

export interface ProfileMatchInput {
  platform: PlatformType;
  chatId: string;
  threadId?: string;
}

/**
 * Higher value = more specific match. A route that declares more of its
 * discriminators is tried before a looser one.
 */
function specificity(route: ProfileRoute): number {
  let s = 0;
  if (route.chatId) s += 4;
  if (route.threadId) s += 8;
  return s;
}

function matches(route: ProfileRoute, input: ProfileMatchInput): boolean {
  if (route.enabled === false) return false;
  if (route.platform !== input.platform) return false;
  if (route.threadId && route.threadId !== input.threadId) return false;
  if (route.chatId && route.chatId !== input.chatId) return false;
  return true;
}

/**
 * Sort routes most-specific-first so the first match wins.
 */
export function sortRoutes(routes: ProfileRoute[]): ProfileRoute[] {
  return [...routes].sort((a, b) => specificity(b) - specificity(a));
}

/**
 * Resolve the best-matching profile for an inbound source, or null when no
 * route matches (caller falls back to the default profile).
 */
export function matchProfileRoute(
  routes: ProfileRoute[],
  input: ProfileMatchInput,
): ProfileRoute | null {
  for (const route of sortRoutes(routes)) {
    if (matches(route, input)) return route;
  }
  return null;
}

/**
 * Parse raw profile routes (e.g. from a config file) into ProfileRoute objects.
 * Invalid entries (missing platform/profile) are skipped.
 */
export function parseProfileRoutes(raw: unknown): ProfileRoute[] {
  if (!Array.isArray(raw)) return [];
  const routes: ProfileRoute[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const platform = e.platform as PlatformType | undefined;
    const profile = e.profile as string | undefined;
    if (!platform || !profile) continue;
    routes.push({
      name: (e.name as string) || `${platform}:${(e.chatId as string) ?? '*'}`,
      platform,
      profile,
      chatId: e.chatId as string | undefined,
      threadId: e.threadId as string | undefined,
      enabled: (e.enabled as boolean | undefined) ?? true,
    });
  }
  return sortRoutes(routes);
}