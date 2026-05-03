import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { CUSTOM_TYPE, type GoalEntry, type GoalState, type GoalStatus } from "./types";
import { newGoalId, nowSeconds } from "./utils";

export class GoalStore {
  private goal: GoalState | null = null;

  constructor(private readonly pi: ExtensionAPI) {}

  get() {
    return this.goal;
  }

  reconstruct(ctx: ExtensionContext) {
    this.goal = null;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== CUSTOM_TYPE) continue;
      const data = entry.data as GoalEntry;
      this.goal = data.action === "set" ? data.goal : null;
    }
  }

  create(objective: string, tokenBudget?: number) {
    if (this.goal) {
      throw new Error("cannot create a new goal because this thread already has a goal; use update_goal only when the existing goal is complete or /goal clear first");
    }
    const t = nowSeconds();
    this.goal = {
      id: newGoalId(),
      objective,
      status: "active",
      tokenBudget: tokenBudget && tokenBudget > 0 ? Math.floor(tokenBudget) : undefined,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: t,
      updatedAt: t,
    };
    this.persist("create");
    return this.goal;
  }

  setStatus(status: GoalStatus, reason: string) {
    if (!this.goal) throw new Error("no goal exists");
    this.goal = { ...this.goal, status, updatedAt: nowSeconds() };
    this.persist(reason);
    return this.goal;
  }

  clear() {
    this.goal = null;
    this.persist("clear");
  }

  addTokenUsage(tokens: number) {
    if (!this.goal) return;
    this.goal.tokensUsed += Math.max(0, tokens);
  }

  addElapsedSeconds(seconds: number) {
    if (!this.goal) return;
    this.goal.timeUsedSeconds += Math.max(0, seconds);
    this.goal.updatedAt = nowSeconds();
  }

  markContinued() {
    if (!this.goal) return;
    this.goal.lastContinuationAt = nowSeconds();
    this.persist("continue");
  }

  persist(reason: string) {
    this.pi.appendEntry(CUSTOM_TYPE, {
      action: this.goal ? "set" : "clear",
      goal: this.goal,
      reason,
    } satisfies GoalEntry);
  }
}
