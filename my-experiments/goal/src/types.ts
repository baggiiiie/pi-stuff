export type GoalStatus = "active" | "paused" | "complete" | "budget_limited";

export interface GoalState {
  id: string;
  objective: string;
  status: GoalStatus;
  tokenBudget?: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
  lastContinuationAt?: number;
}

export interface GoalEntry {
  action: "set" | "clear";
  goal: GoalState | null;
  reason?: string;
}

export const CUSTOM_TYPE = "pi-goal-state";
