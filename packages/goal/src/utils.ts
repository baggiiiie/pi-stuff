import type { GoalState } from "./types";

export function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

export function newGoalId() {
  return `goal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function remainingTokens(goal: GoalState) {
  return goal.tokenBudget == null ? undefined : Math.max(0, goal.tokenBudget - goal.tokensUsed);
}

export function estimateTokens(text: string) {
  return Math.ceil(text.length / 4);
}

export function goalToolResponse(goal: GoalState | null, includeCompletionReport = false) {
  const completion_budget_report = includeCompletionReport && goal?.status === "complete"
    ? `Goal achieved. Report final budget usage to the user: ${goal.tokenBudget ? `tokens used: ${goal.tokensUsed} of ${goal.tokenBudget}; ` : ""}time used: ${goal.timeUsedSeconds} seconds.`
    : undefined;

  return JSON.stringify({
    goal: goal && {
      objective: goal.objective,
      status: goal.status,
      token_budget: goal.tokenBudget ?? null,
      tokens_used: goal.tokensUsed,
      time_used_seconds: goal.timeUsedSeconds,
      created_at: goal.createdAt,
      updated_at: goal.updatedAt,
    },
    remaining_tokens: goal ? remainingTokens(goal) ?? null : null,
    completion_budget_report,
  }, null, 2);
}
