export type ModelsErrorCode =
  | 'auth'
  | 'oauth'
  | 'provider'
  | 'stream'
  | 'model_source';

export class ModelsError extends Error {
  constructor(
    readonly code: ModelsErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ModelsError';
  }
}