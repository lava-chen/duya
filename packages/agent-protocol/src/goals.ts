export type GoalStatus = 'active' | 'paused' | 'usage_limited' | 'complete';

export interface SessionGoal {
  id: string;
  sessionId: string;
  goalText: string | null;
  status: GoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface GoalCreateInput {
  id: string;
  sessionId: string;
  goalText?: string | null;
  tokenBudget?: number | null;
}

export interface GoalBudgetDelta {
  tokensUsedDelta?: number;
  timeUsedDelta?: number;
}

/** Typed async persistence API for session-scoped goal state and budgets. */
export interface HostGoalApiV1 {
  getGoal(sessionId: string): Promise<SessionGoal | null>;
  /** Insert once per session; repeated calls return the existing goal. */
  getOrCreateGoal(input: GoalCreateInput): Promise<SessionGoal>;
  updateBudget(sessionId: string, delta: GoalBudgetDelta): Promise<SessionGoal | null>;
  setStatus(sessionId: string, status: GoalStatus): Promise<SessionGoal | null>;
  listByStatus(status: GoalStatus): Promise<SessionGoal[]>;
}
