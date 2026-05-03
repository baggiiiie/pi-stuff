import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { budgetLimitPrompt, continuationPrompt } from "./prompts";
import type { GoalStore } from "./state";
import { refreshGoalUi } from "./ui";
import { estimateTokens } from "./utils";

export function registerGoalRuntime(pi: ExtensionAPI, store: GoalStore, shouldSuppressContinuation: () => boolean, clearSuppression: () => void) {
  let turnStart = 0;
  let turnTokenBaseline = 0;

  pi.on("session_start", async (_event, ctx) => {
    store.reconstruct(ctx);
    refreshGoalUi(ctx, store);
  });

  pi.on("session_tree", async (_event, ctx) => {
    store.reconstruct(ctx);
    refreshGoalUi(ctx, store);
  });

  pi.on("turn_start", async () => {
    turnStart = Date.now();
    turnTokenBaseline = store.get()?.tokensUsed ?? 0;
  });

  pi.on("message_end", async (event) => {
    const goal = store.get();
    if (!goal || goal.status !== "active") return;
    if (event.message.role === "assistant") {
      store.addTokenUsage(estimateTokens(JSON.stringify(event.message.content ?? "")));
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    const goal = store.get();
    if (!goal || goal.status !== "active") return;

    store.addElapsedSeconds(Math.round((Date.now() - turnStart) / 1000));
    store.persist("accounting");
    refreshGoalUi(ctx, store);

    if (shouldSuppressContinuation()) {
      clearSuppression();
      return;
    }

    const updated = store.get();
    if (!updated) return;

    const hitBudget = updated.tokenBudget != null && updated.tokensUsed >= updated.tokenBudget;
    if (hitBudget) {
      const limited = store.setStatus("budget_limited", "budget_limit");
      pi.sendUserMessage(budgetLimitPrompt(limited), { deliverAs: "followUp" });
      return;
    }

    if (updated.tokensUsed > turnTokenBaseline) {
      store.markContinued();
      const continued = store.get();
      if (continued) pi.sendUserMessage(continuationPrompt(continued), { deliverAs: "followUp" });
    }
  });
}
