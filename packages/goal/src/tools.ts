import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import type { GoalStore } from "./state";
import { goalToolResponse } from "./utils";
import { refreshGoalUi } from "./ui";

const CreateGoalParams = Type.Object({
  objective: Type.String({ minLength: 1, description: "Required. The concrete objective to pursue. Only create a goal when explicitly requested by the user/system/developer." }),
  token_budget: Type.Optional(Type.Integer({ minimum: 1, description: "Optional positive token budget for the new active goal." })),
});

const UpdateGoalParams = Type.Object({
  status: StringEnum(["complete"] as const, { description: "Required. Set to complete only when the objective is achieved and no required work remains." }),
});

export function registerGoalTools(pi: ExtensionAPI, store: GoalStore, suppressContinuation: () => void) {
  pi.registerTool({
    name: "get_goal",
    label: "Get Goal",
    description: "Get the current goal for this thread, including status, budgets, token/time usage, and remaining token budget.",
    promptSnippet: "Inspect the current persisted thread goal and budget usage.",
    parameters: Type.Object({}),
    async execute() {
      const goal = store.get();
      return { content: [{ type: "text", text: goalToolResponse(goal) }], details: { goal } };
    },
  });

  pi.registerTool({
    name: "create_goal",
    label: "Create Goal",
    description: "Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks. Fails if a goal already exists.",
    promptSnippet: "Create an explicitly requested persisted thread goal.",
    parameters: CreateGoalParams,
    async execute(_id, params, _signal, _update, ctx) {
      try {
        const goal = store.create(params.objective, params.token_budget);
        refreshGoalUi(ctx, store);
        return { content: [{ type: "text", text: goalToolResponse(goal) }], details: { goal } };
      } catch (e: any) {
        return { isError: true, content: [{ type: "text", text: e.message }], details: { error: e.message, goal: store.get() } };
      }
    },
  });

  pi.registerTool({
    name: "update_goal",
    label: "Update Goal",
    description: "Update the existing goal. Use only to mark the goal complete when the objective is achieved; pause/resume/budget-limit are user/system controlled.",
    promptSnippet: "Mark a goal complete after auditing that all requirements are satisfied.",
    parameters: UpdateGoalParams,
    async execute(_id, _params, _signal, _update, ctx) {
      try {
        const goal = store.setStatus("complete", "complete");
        suppressContinuation();
        refreshGoalUi(ctx, store);
        return { content: [{ type: "text", text: goalToolResponse(goal, true) }], details: { goal } };
      } catch (e: any) {
        return { isError: true, content: [{ type: "text", text: e.message }], details: { error: e.message, goal: store.get() } };
      }
    },
  });
}
