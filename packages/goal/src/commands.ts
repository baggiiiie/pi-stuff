import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { continuationPrompt } from "./prompts";
import type { GoalStore } from "./state";
import { refreshGoalUi } from "./ui";
import { goalToolResponse } from "./utils";

export function registerGoalCommand(pi: ExtensionAPI, store: GoalStore) {
  pi.registerCommand("goal", {
    description: "Manage persisted goals: /goal <objective>, /goal pause|resume|clear|status [--tokens N]",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const [cmd] = trimmed.split(/\s+/);

      try {
        if (!trimmed || cmd === "status") {
          ctx.ui.notify(store.get() ? goalToolResponse(store.get()) : "No goal", "info");
          return;
        }

        if (cmd === "pause") {
          store.setStatus("paused", "pause");
          refreshGoalUi(ctx, store);
          ctx.ui.notify("Goal paused", "info");
          return;
        }

        if (cmd === "resume") {
          const goal = store.setStatus("active", "resume");
          refreshGoalUi(ctx, store);
          ctx.ui.notify("Goal resumed", "info");
          pi.sendUserMessage(continuationPrompt(goal), { deliverAs: "followUp" });
          return;
        }

        if (cmd === "clear") {
          store.clear();
          refreshGoalUi(ctx, store);
          ctx.ui.notify("Goal cleared", "info");
          return;
        }

        const match = trimmed.match(/^(.*?)(?:\s+--tokens\s+(\d+))?$/)!;
        const goal = store.create(match[1].trim(), match[2] ? Number(match[2]) : undefined);
        refreshGoalUi(ctx, store);
        ctx.ui.notify(`Goal created: ${goal.objective}`, "success");
        pi.sendUserMessage(continuationPrompt(goal), { deliverAs: "followUp" });
      } catch (e: any) {
        ctx.ui.notify(e.message, "error");
      }
    },
  });
}
