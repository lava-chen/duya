/**
 * Session hooks management for duya Agent
 *
 * Adapted from claude-code-haha/src/utils/hooks/sessionHooks.ts
 * Session hooks are temporary, in-memory hooks scoped to a session/agent.
 */

import type { HookEvent, HookCommand, FunctionHook } from '../types.js';

// ============================================================================
// Types
// ============================================================================

type OnHookSuccess = (
  hook: HookCommand | FunctionHook,
  result: { outcome: string },
) => void;

type SessionHookMatcher = {
  matcher: string
  skillRoot?: string
  hooks: Array<{
    hook: HookCommand | FunctionHook
    onHookSuccess?: OnHookSuccess
  }>
};

// ============================================================================
// Session Hook Store
// ============================================================================

/**
 * Global session hooks state
 * Map<sessionId, SessionHooks>
 */
const sessionHooksStore: Map<string, { hooks: Partial<Record<HookEvent, SessionHookMatcher[]>> }> = new Map();

// ============================================================================
// Session Hook Functions
// ============================================================================

/**
 * Add a command or prompt hook to the session.
 * Session hooks are temporary, in-memory only, and cleared when session ends.
 */
export function addSessionHook(
  sessionId: string,
  event: HookEvent,
  matcher: string,
  hook: HookCommand | FunctionHook,
  onHookSuccess?: OnHookSuccess,
  skillRoot?: string,
): void {
  const store = sessionHooksStore.get(sessionId) ?? { hooks: {} };
  const eventMatchers = store.hooks[event] || [];

  // Find existing matcher or create new one
  const existingMatcherIndex = eventMatchers.findIndex(
    m => m.matcher === matcher && m.skillRoot === skillRoot,
  );

  let updatedMatchers: SessionHookMatcher[];
  if (existingMatcherIndex >= 0) {
    // Add to existing matcher
    updatedMatchers = [...eventMatchers];
    const existingMatcher = updatedMatchers[existingMatcherIndex]!;
    updatedMatchers[existingMatcherIndex] = {
      matcher: existingMatcher.matcher,
      skillRoot: existingMatcher.skillRoot,
      hooks: [...existingMatcher.hooks, { hook, onHookSuccess }],
    };
  } else {
    // Create new matcher
    updatedMatchers = [
      ...eventMatchers,
      {
        matcher,
        skillRoot,
        hooks: [{ hook, onHookSuccess }],
      },
    ];
  }

  store.hooks[event] = updatedMatchers;
  sessionHooksStore.set(sessionId, store);
}

/**
 * Add a function hook to the session.
 * Function hooks execute TypeScript callbacks in-memory for validation.
 * @returns The hook ID (for removal)
 */
export function addFunctionHook(
  sessionId: string,
  event: HookEvent,
  matcher: string,
  callback: (input: unknown, toolUseID: string | null, signal?: AbortSignal) => boolean | Promise<boolean>,
  errorMessage: string,
  options?: {
    timeout?: number
    id?: string
  },
): string {
  const id = options?.id || `function-hook-${Date.now()}-${Math.random()}`;
  const hook: FunctionHook = {
    type: 'function',
    id,
    timeout: options?.timeout || 5000,
    callback,
    errorMessage,
  };
  addSessionHook(sessionId, event, matcher, hook);
  return id;
}

/**
 * Remove a function hook by ID from the session.
 */
export function removeFunctionHook(
  sessionId: string,
  event: HookEvent,
  hookId: string,
): void {
  const store = sessionHooksStore.get(sessionId);
  if (!store) {
    return;
  }

  const eventMatchers = store.hooks[event] || [];

  // Remove the hook with matching ID from all matchers
  const updatedMatchers = eventMatchers
    .map(matcher => {
      const updatedHooks = matcher.hooks.filter(h => {
        if (h.hook.type !== 'function') return true;
        return h.hook.id !== hookId;
      });

      return updatedHooks.length > 0
        ? { ...matcher, hooks: updatedHooks }
        : null;
    })
    .filter((m): m is SessionHookMatcher => m !== null);

  const newHooks =
    updatedMatchers.length > 0
      ? { ...store.hooks, [event]: updatedMatchers }
      : Object.fromEntries(
          Object.entries(store.hooks).filter(([e]) => e !== event),
        );

  store.hooks = newHooks as Partial<Record<HookEvent, SessionHookMatcher[]>>;
  sessionHooksStore.set(sessionId, store);
}

/**
 * Remove a specific hook from the session
 */
export function removeSessionHook(
  sessionId: string,
  event: HookEvent,
  hook: HookCommand,
): void {
  const store = sessionHooksStore.get(sessionId);
  if (!store) {
    return;
  }

  const eventMatchers = store.hooks[event] || [];

  // Remove the hook from all matchers
  const updatedMatchers = eventMatchers
    .map(matcher => {
      const updatedHooks = matcher.hooks.filter(h => {
        // Function hooks can't be compared by command content, keep them
        if (h.hook.type === 'function') return true;
        // Compare command/prompt content for non-function hooks
        return !isHookEqual(h.hook, hook);
      });

      return updatedHooks.length > 0
        ? { ...matcher, hooks: updatedHooks }
        : null;
    })
    .filter((m): m is SessionHookMatcher => m !== null);

  const newHooks =
    updatedMatchers.length > 0
      ? { ...store.hooks, [event]: updatedMatchers }
      : { ...store.hooks };

  if (updatedMatchers.length === 0) {
    delete newHooks[event];
  }

  store.hooks = newHooks as Partial<Record<HookEvent, SessionHookMatcher[]>>;
  sessionHooksStore.set(sessionId, store);
}

/**
 * Get all session hooks for a specific event
 */
export function getSessionHooks(
  sessionId: string,
  event?: HookEvent,
): Map<HookEvent, SessionHookMatcher[]> {
  const store = sessionHooksStore.get(sessionId);
  if (!store) {
    return new Map();
  }

  const result = new Map<HookEvent, SessionHookMatcher[]>();

  if (event) {
    const sessionMatchers = store.hooks[event];
    if (sessionMatchers) {
      result.set(event, sessionMatchers);
    }
    return result;
  }

  for (const evt of Object.keys(store.hooks) as HookEvent[]) {
    const sessionMatchers = store.hooks[evt];
    if (sessionMatchers) {
      result.set(evt, sessionMatchers);
    }
  }

  return result;
}

/**
 * Get all session function hooks for a specific event
 */
export function getSessionFunctionHooks(
  sessionId: string,
  event?: HookEvent,
): Map<HookEvent, { matcher: string; hooks: FunctionHook[] }[]> {
  const store = sessionHooksStore.get(sessionId);
  if (!store) {
    return new Map();
  }

  const result = new Map<HookEvent, { matcher: string; hooks: FunctionHook[] }[]>();

  const extractFunctionHooks = (
    sessionMatchers: SessionHookMatcher[],
  ): { matcher: string; hooks: FunctionHook[] }[] => {
    return sessionMatchers
      .map(sm => ({
        matcher: sm.matcher,
        hooks: sm.hooks
          .map(h => h.hook)
          .filter((h): h is FunctionHook => h.type === 'function'),
      }))
      .filter(m => m.hooks.length > 0);
  };

  if (event) {
    const sessionMatchers = store.hooks[event];
    if (sessionMatchers) {
      const functionMatchers = extractFunctionHooks(sessionMatchers);
      if (functionMatchers.length > 0) {
        result.set(event, functionMatchers);
      }
    }
    return result;
  }

  for (const evt of Object.keys(store.hooks) as HookEvent[]) {
    const sessionMatchers = store.hooks[evt];
    if (sessionMatchers) {
      const functionMatchers = extractFunctionHooks(sessionMatchers);
      if (functionMatchers.length > 0) {
        result.set(evt, functionMatchers);
      }
    }
  }

  return result;
}

/**
 * Clear all session hooks for a specific session
 */
export function clearSessionHooks(sessionId: string): void {
  sessionHooksStore.delete(sessionId);
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Check if two hooks are equal (comparing only command/prompt content, not timeout)
 */
function isHookEqual(
  a: HookCommand,
  b: HookCommand,
): boolean {
  if (a.type !== b.type) return false;

  const sameIf = (x: { if?: string }, y: { if?: string }) =>
    (x.if ?? '') === (y.if ?? '');

  switch (a.type) {
    case 'command':
      return b.type === 'command' && a.command === b.command && sameIf(a, b);
    case 'http':
      return b.type === 'http' && a.url === b.url && sameIf(a, b);
    case 'agent':
      return b.type === 'agent' && a.prompt === b.prompt && sameIf(a, b);
    default:
      return false;
  }
}

// Re-export types for convenience
export type { SessionHookMatcher };
