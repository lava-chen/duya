/**
 * bot-avatar.ts — Bot avatar color tokens + avatar image rules (Plan 483/485,
 * revised 2026-09-05: geometric shape tokens removed — an avatar is either a
 * colored initial circle (color token) or an uploaded image file stored in
 * the bot's agent directory).
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

/**
 * Allowed avatar image files: the canonical stem `avatar` plus a fixed
 * extension whitelist. Filenames are validated before any path is resolved
 * inside the agent directory (no separators / traversal possible).
 */
export const AVATAR_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'] as const;

export type BotAvatarImageExtension = (typeof AVATAR_IMAGE_EXTENSIONS)[number];

const AVATAR_IMAGE_STEM = 'avatar';
const EXT_SET: ReadonlySet<string> = new Set(AVATAR_IMAGE_EXTENSIONS);

/**
 * Split `<stem>.<ext>` without regex; returns null unless the string has
 * exactly one dot-separated extension (used for avatar filename validation).
 */
function splitStemExtension(
  value: string,
): { stem: string; ext: string } | null {
  const dot = value.indexOf('.');
  if (dot <= 0 || dot === value.length - 1) return null;
  if (value.indexOf('.', dot + 1) !== -1) return null;
  return { stem: value.slice(0, dot), ext: value.slice(dot + 1).toLowerCase() };
}

export function isValidAvatarImageFilename(
  value: unknown,
): value is `avatar.${BotAvatarImageExtension}` {
  if (typeof value !== 'string') return false;
  const parts = splitStemExtension(value);
  return parts !== null && parts.stem === AVATAR_IMAGE_STEM && EXT_SET.has(parts.ext);
}

/** Extension of a stored avatar filename (canonical `avatar.*` stem); null when not whitelisted. */
export function avatarImageExtension(filename: string): BotAvatarImageExtension | null {
  const parts = splitStemExtension(filename);
  if (parts === null || parts.stem !== AVATAR_IMAGE_STEM || !EXT_SET.has(parts.ext)) {
    return null;
  }
  return parts.ext as BotAvatarImageExtension;
}

/**
 * Extension of an avatar IMAGE SOURCE (a user-picked or model-generated
 * file with an arbitrary name — e.g. `photo.png`, `generated.svg`).
 * Only the extension is checked; the `avatar.*` stem applies to stored
 * filenames, not sources.
 */
export function avatarSourceExtension(filename: string): BotAvatarImageExtension | null {
  const parts = splitStemExtension(filename);
  return parts !== null && EXT_SET.has(parts.ext) ? (parts.ext as BotAvatarImageExtension) : null;
}

export const BOT_AVATAR_MAX_BYTES = 5 * 1024 * 1024;
