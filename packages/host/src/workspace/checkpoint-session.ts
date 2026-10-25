/** Preserve existing UUID namespaces while supporting bot/spawn session IDs. */
export function checkpointSessionComponent(sessionId: string): string {
  const value = sessionId.trim();
  if (!/^[A-Za-z0-9._:-]+$/.test(value) || value === '.' || value === '..') throw new Error('Session id cannot be used in a checkpoint namespace.');
  return value.replace(/:/g, '%3A');
}
