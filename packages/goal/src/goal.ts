import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerGoalCommand } from "./commands";
import { registerGoalRuntime } from "./runtime";
import { GoalStore } from "./state";
import { registerGoalTools } from "./tools";

/**
 * Codex-style persisted goals for pi.
 *
 * Persisted state, model tools, /goal controls, runtime continuation, and
 * token/time budget handling.
 */
export default function (pi: ExtensionAPI) {
  const store = new GoalStore(pi);
  let suppressNextContinuation = false;

  registerGoalRuntime(
    pi,
    store,
    () => suppressNextContinuation,
    () => { suppressNextContinuation = false; },
  );
  registerGoalTools(pi, store, () => { suppressNextContinuation = true; });
  registerGoalCommand(pi, store);
}
