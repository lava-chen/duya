const TRANSCRIPT_MUTATION_ACTIONS = new Set([
  'message:add',
  'message:append',
  'message:deleteBySession',
  'message:replace',
]);

/** Worker actions that can add, replace, or remove durable chat transcript data. */
export function isWorkerTranscriptMutationAction(action: string): boolean {
  return TRANSCRIPT_MUTATION_ACTIONS.has(action);
}
