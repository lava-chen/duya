// Deterministic per-agent color. Hashes a stable identifier (agentId or
// agent name) so the same sub-agent always renders with the same color,
// independent of event arrival order or mount timing.

export const AGENT_PALETTE: string[] = [
  'var(--accent)',
  '#f97316', // orange
  '#22c55e', // green
  '#ef4444', // red
  '#a855f7', // purple
  '#06b6d4', // cyan
  '#eab308', // yellow
];

function hashString(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash) + input.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

export function colorForAgent(key: string): string {
  if (!key) return AGENT_PALETTE[0];
  const hash = hashString(key);
  return AGENT_PALETTE[Math.abs(hash) % AGENT_PALETTE.length] || AGENT_PALETTE[0];
}
