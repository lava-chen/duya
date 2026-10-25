/** Session execution-location controls, shared by tools and local clients. */
export interface SessionCheckoutAttachment {
  readonly root: string;
  readonly cwd: string;
  readonly baseSha: string;
  readonly baseRef?: string;
  readonly returnCwd: string;
}

export type SessionCheckoutCommand =
  | { readonly action: 'status' }
  | { readonly action: 'recover' }
  | { readonly action: 'enter'; readonly name?: string; readonly path?: string; readonly base?: string; readonly branchName?: string }
  | { readonly action: 'exit'; readonly disposition?: 'keep' | 'remove' }
  | { readonly action: 'sync'; readonly base?: string; readonly abort?: boolean };

export interface SessionCheckoutJournal {
  readonly id: string;
  readonly command: Exclude<SessionCheckoutCommand, { readonly action: 'status' | 'recover' }>;
  readonly sourceCwd: string;
  readonly target: SessionCheckoutAttachment | null;
}

/** Cursor and operation intent; checkout ownership remains in Git's owner file. */
export interface SessionCheckoutState {
  readonly version: 1;
  readonly revision: number;
  readonly cwd: string;
  readonly checkout: SessionCheckoutAttachment | null;
  readonly pending: SessionCheckoutJournal | null;
  readonly mergeBase?: string;
}

export interface SessionCheckoutResult {
  readonly state: SessionCheckoutState;
  readonly outcome: 'status' | 'entered' | 'left' | 'recovered' | 'merged' | 'up_to_date' | 'conflicts' | 'aborted';
  readonly sourceChangesExcluded?: boolean;
  readonly checkpoint?: string;
  readonly conflicts?: readonly string[];
  readonly removal?: { readonly removed: true } | { readonly removed: false; readonly reason: string };
}

export interface HostSessionCheckoutApiV1 {
  control(sessionId: string, command: SessionCheckoutCommand): Promise<SessionCheckoutResult>;
}
