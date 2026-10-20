export type Scope = 'skip' | 'changed' | 'full' | 'run';

export interface TestScopes {
  unitScope: 'skip' | 'changed' | 'full';
  e2eScope: 'skip' | 'changed' | 'full';
  buildScope: 'skip' | 'run';
  e2eFiles: string[];
}

export function classifyChangedFiles(changedPaths: readonly string[]): TestScopes;
export function getScopesForEvent(eventName: string, env?: NodeJS.ProcessEnv): TestScopes;
