/** Plan 490 P1 constants for the ReactToMessage tool. */

export const REACT_TO_MESSAGE_TOOL_NAME = 'ReactToMessage';

/** Max characters accepted in the `emoji` field (grok parity). */
export const MAX_EMOJI_CHARS = 16;

/** Structured error codes surfaced to the model. */
export type ReactToMessageErrorCode =
  | 'INVALID_INPUT'
  | 'NO_SESSION'
  | 'NOT_FOUND'
  | 'NOT_REACTABLE'
  | 'BRIDGE_ERROR';
