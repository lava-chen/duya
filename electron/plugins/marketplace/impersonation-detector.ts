const OFFICIAL_MARKETPLACE_NAMES = new Set([
  'duya-official',
  'duya-marketplace',
  'duya-plugins',
]);

const BLOCKED_NAME_PATTERN =
  /(?:official[^a-z0-9]*(duya)|duya[^a-z0-9]*official|duya[^a-z0-9]*(marketplace|plugins|official))/i;

const NON_ASCII_PATTERN = /[^\u0020-\u007E]/;

export function isBlockedMarketplaceName(name: string): boolean {
  if (OFFICIAL_MARKETPLACE_NAMES.has(name.toLowerCase())) {
    return false;
  }
  if (NON_ASCII_PATTERN.test(name)) {
    return true;
  }
  return BLOCKED_NAME_PATTERN.test(name);
}