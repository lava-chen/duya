/**
 * bot-avatar.ts — Bot avatar color tokens (Plan 483/485).
 *
 * The avatar itself is now the animated agent face (`@/components/agent-face`);
 * the uploaded-image pipeline (avatar.* files, whitelists, size caps) was
 * removed along with the emoji tiles. What survives is the color token set:
 * the face body color, seeded into `agents/<id>/profile.json` and editable by
 * the bot itself via `bot-identity:rpc`.
 *
 * Canonical constants live here (main process); the renderer keeps a
 * synced copy in `src/lib/bot-avatar.ts` (same convention as git-ipc).
 */

export interface AvatarColorToken {
  id: string;
  label: string;
  value: string;
}

export const AVATAR_COLORS: readonly AvatarColorToken[] = [
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

export type BotAvatarColor = (typeof AVATAR_COLORS)[number]['id'];

const COLOR_SET: ReadonlySet<string> = new Set(AVATAR_COLORS.map((c) => c.id));

export function isValidAvatarColor(value: unknown): value is BotAvatarColor {
  return typeof value === 'string' && COLOR_SET.has(value);
}

/** Hex for a known color token; unknown/empty → null (caller falls back). */
export function avatarColorHex(color: string): string | null {
  return AVATAR_COLORS.find((c) => c.id === color)?.value ?? null;
}
