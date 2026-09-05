/**
 * Bot model-selection persistence (localStorage).
 *
 * Remembers the model / provider / effort the user picked for a bot so the
 * choice survives switching chats and app restarts. Mirrors the session
 * composer's thread-level persistence, but keyed per bot id: bot threads are
 * lazily created server-side on first send, so a conversation-store row (and
 * thus `setThreadModel`) is not always available when the user picks a model.
 *
 * Storage key: `bot-model-pref:${botId}`
 * Value: { model, providerId?, effort?, updatedAt }
 */

export interface BotModelPreference {
  /** Raw model id (no `[provider] ` prefix). */
  model: string;
  providerId?: string;
  /** Anthropic thinking-effort level (low/medium/high/max). */
  effort?: string;
  updatedAt: number;
}

const PREF_PREFIX = 'bot-model-pref:';

function getPrefKey(botId: string): string {
  return `${PREF_PREFIX}${botId}`;
}

/**
 * Load the persisted model preference for a botId.
 */
export function loadBotModelPreference(botId: string): BotModelPreference | null {
  try {
    const key = getPrefKey(botId);
    const stored = localStorage.getItem(key);
    if (!stored) return null;
    const pref = JSON.parse(stored) as BotModelPreference;
    if (typeof pref.model !== 'string' || pref.model.length === 0) {
      localStorage.removeItem(key);
      return null;
    }
    return pref;
  } catch {
    return null;
  }
}

/**
 * Save the model preference for a botId.
 */
export function saveBotModelPreference(
  botId: string,
  preference: Pick<BotModelPreference, 'model' | 'providerId' | 'effort'>,
): void {
  try {
    const key = getPrefKey(botId);
    const value: BotModelPreference = { ...preference, updatedAt: Date.now() };
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // localStorage might be full or disabled - fail silently
  }
}
