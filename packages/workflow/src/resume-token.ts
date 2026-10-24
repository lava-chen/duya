/** Token vocabulary and cryptographic port. Signing stays in the Host. */
export interface ResumeTokenPayload {
  runId: string;
  nodeId: string;
  issuedAt: number;
  nonce: string;
}

export interface ResumeTokenPort {
  create(payload: Omit<ResumeTokenPayload, 'nonce'> & { nonce?: string }): string;
  verify(token: string): ResumeTokenPayload | null;
}

export function isResumeTokenPayload(value: unknown): value is ResumeTokenPayload {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Record<string, unknown>;
  return typeof payload.runId === 'string' &&
    typeof payload.nodeId === 'string' &&
    typeof payload.issuedAt === 'number' &&
    Number.isFinite(payload.issuedAt) &&
    typeof payload.nonce === 'string';
}
