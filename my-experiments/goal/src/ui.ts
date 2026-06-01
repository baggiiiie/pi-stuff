import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { GoalStore } from "./state";
import { remainingTokens } from "./utils";

export function refreshGoalUi(ctx: ExtensionContext | undefined, store: GoalStore) {
  if (!ctx?.hasUI) return;
  const goal = store.get();
  if (!goal) {
    ctx.ui.setStatus("goal", "");
    ctx.ui.setWidget("goal", []);
    return;
  }

  const rem = remainingTokens(goal);
  const budget = rem == null ? "" : ` • ${rem}/${goal.tokenBudget} tok left`;
  ctx.ui.setStatus("goal", `goal: ${goal.status}`);
  ctx.ui.setWidget("goal", [
    `🎯 ${goal.status}: ${goal.objective}${budget}`,
    `time ${goal.timeUsedSeconds}s • tokens ${goal.tokensUsed}`,
  ]);
}
