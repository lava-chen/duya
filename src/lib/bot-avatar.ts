/**
 * bot-avatar.ts — renderer mirror of `electron/config/bot-avatar.ts`
 * (Plan 483/485, revised 2026-09-05: shape tokens removed; an avatar is a
 * colored initial circle or an uploaded image file). Keep the two files
 * synchronized: canonical source is the main-process module; unknown tokens
 * must fall back gracefully.
 */

export interface BotAvatarColorToken {
  id: string;
  label: string;
  value: string;
}

export const BOT_AVATAR_COLORS: readonly BotAvatarColorToken[] = [
  { id: 'black', label: 'Black', value: '#000000' },
  { id: 'brown', label: 'Brown', value: '#936439' },
  { id: 'red', label: 'Red', value: '#FF263C' },
  { id: 'orange', label: 'Orange', value: '#FF6700' },
  { id: 'yellow', label: 'Yellow', value: '#FF9800' },
  { id: 'green', label: 'Green', value: '#00C972' },
  { id: 'cyan', label: 'Cyan', value: '#00BCA6' },
  { id: 'blue', label: 'Blue', value: '#1084FE' },
  { id: 'violet', label: 'Violet', value: '#9159FE' },
  { id: 'magenta', label: 'Magenta', value: '#FF309B' },
  { id: 'gray', label: 'Gray', value: '#777777' },
];

/** Hex for a known color token; unknown/empty → null (caller falls back). */
export function botAvatarColorHex(color: string | undefined): string | null {
  if (!color) return null;
  return BOT_AVATAR_COLORS.find((c) => c.id === color)?.value ?? null;
}
