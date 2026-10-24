/** Host supplied digest primitive; the workflow package never imports crypto. */
export interface WorkflowHashPort {
  sha256(input: string): string;
}

/** Canonical JSON for stable request and whole-definition hashes. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const body = keys
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
    .join(',');
  return `{${body}}`;
}

export function computeReqHash(kind: string, payload: unknown, hash: WorkflowHashPort): string {
  // Preserve the pre-extraction 16-hex-character key so existing journal
  // entries remain replayable across the package move.
  return hash.sha256(`${kind}\u0000${canonicalJson(payload)}`).slice(0, 16);
}

/** Hash the entire normalized DAG definition, including metadata and phases. */
export function computeDefinitionHash(definition: unknown, hash: WorkflowHashPort): string {
  return hash.sha256(canonicalJson(definition));
}
