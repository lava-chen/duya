/**
 * Plan 491 P2.1: Bot draft state persistence.
 *
 * Persists composer draft text per botId in localStorage.
 * Draft is restored when user switches back to a bot.
 *
 * Storage key: `bot-draft:${botId}`
 * Value: { text: string, updatedAt: number }
 */

export interface BotDraft {
  text: string;
  updatedAt: number;
}

const DRAFT_PREFIX = 'bot-draft:';

/**
 * Get the localStorage key for a bot draft.
 */
function getDraftKey(botId: string): string {
  return `${DRAFT_PREFIX}${botId}`;
}

/**
 * Load draft from localStorage for a given botId.
 */
export function loadBotDraft(botId: string): BotDraft | null {
  try {
    const key = getDraftKey(botId);
    const stored = localStorage.getItem(key);
    if (!stored) return null;
    const draft = JSON.parse(stored) as BotDraft;
    // Basic validation
    if (typeof draft.text !== 'string' || typeof draft.updatedAt !== 'number') {
      localStorage.removeItem(key);
      return null;
    }
    return draft;
  } catch {
    return null;
  }
}

/**
 * Save draft to localStorage for a given botId.
 */
export function saveBotDraft(botId: string, text: string): void {
  try {
    const key = getDraftKey(botId);
    const draft: BotDraft = { text, updatedAt: Date.now() };
    localStorage.setItem(key, JSON.stringify(draft));
  } catch {
    // localStorage might be full or disabled - fail silently
  }
}

/**
 * Clear draft from localStorage for a given botId.
 */
export function clearBotDraft(botId: string): void {
  try {
    const key = getDraftKey(botId);
    localStorage.removeItem(key);
  } catch {
    // Fail silently
  }
}

/**
 * Get all botIds that have saved drafts.
 */
export function getAllDraftBotIds(): string[] {
  try {
    const botIds: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(DRAFT_PREFIX)) {
        botIds.push(key.slice(DRAFT_PREFIX.length));
      }
    }
    return botIds;
  } catch {
    return [];
  }
}

/**
 * Clear all bot drafts.
 */
export function clearAllBotDrafts(): void {
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(DRAFT_PREFIX)) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach((key) => localStorage.removeItem(key));
  } catch {
    // Fail silently
  }
}
