export type TurnReviewFileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';

export interface TurnReviewFile {
  readonly path: string;
  readonly status: TurnReviewFileStatus;
  readonly oldPath?: string;
  readonly additions: number;
  readonly removals: number;
}

/** Local-only persisted review. It contains raw paths and patch contents. */
export interface TurnReviewWriteInput {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly workingDirectory: string;
  readonly files: readonly TurnReviewFile[];
  readonly patch: string;
  readonly additions: number;
  readonly removals: number;
  readonly truncated: boolean;
  readonly binary: boolean;
  readonly capturedAt: number;
}

/** Local persisted projection used by Desktop review history. */
export interface HostLocalTurnReviewRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly workingDirectory: string;
  /** Kept encoded so the Desktop adapter can preserve its corruption handling. */
  readonly filesJson: string;
  readonly patch: string;
  readonly additions: number;
  readonly removals: number;
  readonly truncated: number;
  readonly binary: number;
  readonly capturedAt: number;
}

/** Smaller local projection for the review-history list. */
export interface HostLocalTurnReviewSummary {
  readonly id: string;
  readonly turnId: string;
  /** Kept encoded so malformed historical rows remain listable. */
  readonly filesJson: string;
  readonly additions: number;
  readonly removals: number;
  readonly capturedAt: number;
}

export interface HostLocalTurnReviewApiV1 {
  saveTurnReview(input: TurnReviewWriteInput): Promise<void>;
  getLatestTurnReview(sessionId: string): Promise<HostLocalTurnReviewRecord | null>;
  listTurnReviewHistory(sessionId: string, limit: number): Promise<readonly HostLocalTurnReviewSummary[]>;
  getTurnReviewById(reviewId: string): Promise<HostLocalTurnReviewRecord | null>;
  getTurnReviewByTurnId(sessionId: string, turnId: string): Promise<HostLocalTurnReviewRecord | null>;
}
