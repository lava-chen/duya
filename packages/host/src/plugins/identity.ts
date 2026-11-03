/** IDs and versions are single storage segments on every supported platform. */
export function assertPluginStorageSegment(value: string): void {
  if (!value || value.length > 200 || value === '.' || value === '..' || value.trim() !== value ||
    /[\\/\x00-\x1f:]/u.test(value) || value.endsWith('.') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(value)) {
    throw new Error('Invalid plugin storage identifier');
  }
}
