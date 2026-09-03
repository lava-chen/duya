/**
 * bot-avatar.ts — Bot avatar character tokens (Plan 483 / 485).
 *
 * Mirrors grok-bot's character system: a bot avatar is a (shape, color)
 * token pair rendered as a vector character — no image upload required
 * for the base flow. Rendered by the renderer's BotCharacterAvatar.
 *
 * Canonical constants live here (main process); the renderer keeps a
 * synced copy in `src/lib/bot-avatar.ts` (same convention as git-ipc).
 */

export const AVATAR_SHAPES = [
  'blob',
  'pebble',
  'squircle',
  'tablet',
  'wedge',
  'hex',
  'cloud',
  'teardrop',
] as const;

export type BotAvatarShape = (typeof AVATAR_SHAPES)[number];

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

const SHAPE_SET: ReadonlySet<string> = new Set(AVATAR_SHAPES);
const COLOR_SET: ReadonlySet<string> = new Set(AVATAR_COLORS.map((c) => c.id));

export function isValidAvatarShape(value: unknown): value is BotAvatarShape {
  return typeof value === 'string' && SHAPE_SET.has(value);
}

export function isValidAvatarColor(value: unknown): value is BotAvatarColor {
  return typeof value === 'string' && COLOR_SET.has(value);
}

/** Hex for a known color token; unknown/empty → null (caller falls back). */
export function avatarColorHex(color: string): string | null {
  return AVATAR_COLORS.find((c) => c.id === color)?.value ?? null;
}
