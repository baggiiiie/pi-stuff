import { TypeSafeClient } from "@typesafe-ai/sdk";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import {
  authorizationFingerprint,
  buildReviewContext,
  commandFingerprint,
  type ContextLimits,
  type ReviewContext,
  type ReviewEvidence,
} from "./context.ts";
import {
  reviewActionFresh,
  scoreActionRisk,
  type EvaluationClient,
  type FreshReview,
  type QuickRiskScore,
  type ReviewerConfig,
} from "./typesafe-reviewer.ts";

const REVIEW_ENTRY_TYPE = "approve-for-me-review-v2";
const DEFAULT_MODEL = "jev-latest";
const DEFAULT_RISK_THRESHOLD = 0.5;
const DEFAULT_REVIEWER_CONFIDENCE = 0.65;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_COMMAND_CHARS = 4_000;
const DEFAULT_MAX_SCORE_AGE_MS = 30_000;
const DEFAULT_MAX_MESSAGE_CONTEXT_CHARS = 12_000;
const DEFAULT_MAX_TOOL_CONTEXT_CHARS = 8_000;
const DEFAULT_MAX_CONTEXT_ENTRY_CHARS = 2_000;
const DEFAULT_MAX_RECENT_NON_USER_ENTRIES = 20;
const DEFAULT_MAX_PREVIOUS_REVIEWS = 10;
const MAX_PROMPT_COMMAND_CHARS = 4_000;
const MAX_IN_MEMORY_REVIEWS = 50;
const MAX_CONSECUTIVE_DENIALS = 3;
const MAX_RECENT_DENIALS = 10;
const DENIAL_WINDOW_SIZE = 50;

export type ApproveForMeConfig = ReviewerConfig &
  ContextLimits & {
    enabled: boolean;
    timeoutMs: number;
    maxCommandChars: number;
    maxScoreAgeMs: number;
    baseURL?: string;
  };

type PendingScore = {
  action: BashAction;
  actionHash: string;
  authorizationHash: string;
  startedAt: number;
  controller: AbortController;
  result: Promise<
    | { score: QuickRiskScore }
    | { error: Error }
  >;
};

type BashAction = {
  command: string;
  timeout?: number;
};

type GuardianOptions = {
  config?: ApproveForMeConfig;
  client?: EvaluationClient | null;
  persistReview?: (review: ReviewEvidence) => void;
};

type ToolExecutionStartEvent = {
  type: "tool_execution_start";
  toolCallId: string;
  toolName: string;
  args: unknown;
};

type GuardianToolCallResult = ToolCallEventResult & {
  terminate?: boolean;
};

export function installGuardianApprovalExtension(pi: ExtensionAPI): void {
  const guardian = createGuardianRuntime({
    persistReview: (review) => pi.appendEntry(REVIEW_ENTRY_TYPE, review),
  });

  pi.on("session_start", (_event, ctx) => {
    guardian.restoreReviews(ctx);
  });
  pi.on("agent_start", () => {
    guardian.startAgentRun();
  });
  pi.on("tool_execution_start", (event, ctx) => {
    guardian.startScoring(event, ctx);
  });
  pi.on("tool_call", (event, ctx) => guardian.reviewToolCall(event, ctx));
  pi.on("tool_execution_end", (event) => {
    guardian.finishToolCall(event.toolCallId);
  });
  pi.on("session_shutdown", () => {
    guardian.dispose();
  });
}

export function createGuardianRuntime(
  options: GuardianOptions = {},
): GuardianRuntime {
  const config = options.config ?? readConfig();
  let client: EvaluationClient | undefined;
  let setupError: Error | undefined;

  if (Object.hasOwn(options, "client")) {
    client = options.client ?? undefined;
  } else {
    try {
      client = createTypeSafeClient(config);
    } catch (error) {
      setupError = asError(error);
    }
  }

  return new GuardianRuntime(
    config,
    client,
    setupError,
    options.persistReview,
  );
}

export class GuardianRuntime {
  private readonly pendingScores = new Map<string, PendingScore>();
  private readonly reviews: ReviewEvidence[] = [];
  private readonly config: ApproveForMeConfig;
  private readonly client?: EvaluationClient;
  private readonly setupError?: Error;
  private readonly persistReview?: (review: ReviewEvidence) => void;
  private consecutiveDenials = 0;
  private recentDenials: boolean[] = [];
  private breakerTripped = false;

  constructor(
    config: ApproveForMeConfig,
    client?: EvaluationClient,
    setupError?: Error,
    persistReview?: (review: ReviewEvidence) => void,
  ) {
    this.config = config;
    this.client = client;
    this.setupError = setupError;
    this.persistReview = persistReview;
  }

  startAgentRun(): void {
    this.consecutiveDenials = 0;
    this.recentDenials = [];
    this.breakerTripped = false;
  }

  restoreReviews(ctx: Pick<ExtensionContext, "sessionManager">): void {
    this.reviews.length = 0;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (
        entry.type === "custom" &&
        entry.customType === REVIEW_ENTRY_TYPE &&
        isReviewEvidence(entry.data)
      ) {
        this.reviews.push(entry.data);
      }
    }
    this.trimReviews();
  }

  startScoring(
    event: ToolExecutionStartEvent,
    ctx: ExtensionContext,
  ): void {
    if (
      !this.config.enabled ||
      !this.client ||
      event.toolName !== "bash"
    ) {
      return;
    }
    const action = getBashAction(event.args);
    if (!action || action.command.length > this.config.maxCommandChars) return;

    this.finishToolCall(event.toolCallId);
    this.pendingScores.set(
      event.toolCallId,
      this.createPendingScore(action, ctx, this.client),
    );
  }

  async reviewToolCall(
    event: ToolCallEvent,
    ctx: ExtensionContext,
  ): Promise<GuardianToolCallResult | undefined> {
    if (!this.config.enabled || event.toolName !== "bash") return undefined;
    const action = getBashAction(event.input);
    if (!action) return undefined;
    const { command } = action;

    if (this.breakerTripped) {
      return {
        block: true,
        terminate: true,
        reason:
          "Bash command blocked because the safety denial circuit breaker already stopped this agent run.",
      };
    }

    if (ctx.signal?.aborted) {
      return block("Bash command blocked because safety review was cancelled.");
    }

    let quickScore: QuickRiskScore | undefined;
    let quickError = this.setupError;
    let forceFreshReview = false;

    if (command.length > this.config.maxCommandChars) {
      return block(
        `Bash command blocked because its complete text cannot be inspected safely (${command.length} characters; limit ${this.config.maxCommandChars}).`,
      );
    } else if (!this.client) {
      quickError ??= new Error(
        "TYPESAFE_API_KEY is not set. Export it before starting Pi.",
      );
    } else {
      const pending =
        this.pendingScores.get(event.toolCallId) ??
        this.createPendingScore(action, ctx, this.client);
      this.pendingScores.delete(event.toolCallId);

      const actionChanged = pending.actionHash !== actionFingerprint(action);

      if (actionChanged) {
        pending.controller.abort();
        forceFreshReview = true;
      } else {
        const result = await pending.result;
        if (ctx.signal?.aborted) {
          return block(
            "Bash command blocked because safety review was cancelled.",
          );
        }
        if ("score" in result) quickScore = result.score;
        else quickError = result.error;
        forceFreshReview =
          pending.authorizationHash !== authorizationFingerprint(ctx) ||
          Date.now() - pending.startedAt > this.config.maxScoreAgeMs;
      }
    }

    if (
      quickScore &&
      !forceFreshReview &&
      quickScore.dangerousProbability < this.config.riskThreshold
    ) {
      this.recordReview(ctx, action, "auto_allowed", quickScore, "none", false);
      this.recordNonDenial();
      freezeApprovedEvent(event);
      return undefined;
    }

    let freshReview: FreshReview | undefined;
    let freshError = quickError;
    if (this.client && command.length <= this.config.maxCommandChars) {
      try {
        const beforeReviewAuthorization = authorizationFingerprint(ctx);
        const currentContext = this.buildContext(ctx, action);
        freshReview = await reviewActionFresh(
          this.client,
          currentContext,
          this.config,
          ctx.signal,
        );
        freshError = undefined;
        if (ctx.signal?.aborted) {
          return block(
            "Bash command blocked because safety review was cancelled.",
          );
        }
        if (
          beforeReviewAuthorization !== authorizationFingerprint(ctx) ||
          actionFingerprint(action) !==
            actionFingerprint(getBashAction(event.input) ?? action)
        ) {
          freshError = new Error(
            "The action or authorization changed during fresh review.",
          );
          freshReview = undefined;
        }
      } catch (error) {
        if (ctx.signal?.aborted) {
          return block(
            "Bash command blocked because safety review was cancelled.",
          );
        }
        freshError = asError(error);
      }
    }

    if (freshReview && !freshReview.requiresHumanApproval) {
      this.recordReview(
        ctx,
        action,
        "auto_allowed",
        freshReview,
        freshReview.hazard,
        false,
      );
      this.recordNonDenial();
      freezeApprovedEvent(event);
      return undefined;
    }

    if (!ctx.hasUI) {
      return block(
        freshReview
          ? formatHeadlessBlockedReason(quickScore, freshReview)
          : `Bash command blocked because automatic safety review was unavailable: ${safeErrorMessage(freshError)}`,
      );
    }

    const promptedActionHash = actionFingerprint(action);
    const promptedAuthorizationHash = authorizationFingerprint(ctx);
    let approved = false;
    try {
      approved = await ctx.ui.confirm(
        freshReview
          ? freshReview.recommendation === "deny"
            ? "TypeSafe recommends blocking this command"
            : "Approve risky bash command?"
          : "Safety review unavailable",
        formatApprovalPrompt(
          command,
          ctx.cwd,
          action.timeout,
          quickScore,
          freshReview,
          freshError,
          forceFreshReview,
        ),
      );
    } catch (error) {
      return block(
        `Bash command blocked because the human approval prompt failed: ${safeErrorMessage(asError(error))}`,
      );
    }

    if (ctx.signal?.aborted) {
      return block("Bash command blocked because execution was cancelled.");
    }
    if (
      approved &&
      (promptedAuthorizationHash !== authorizationFingerprint(ctx) ||
        promptedActionHash !==
          actionFingerprint(getBashAction(event.input) ?? action))
    ) {
      return block(
        "Bash command blocked because its action or authorization changed while human approval was pending.",
      );
    }

    if (approved) {
      this.recordReview(
        ctx,
        action,
        "human_approved",
        freshReview ?? quickScore,
        freshReview?.hazard ?? quickScore?.impact ?? "unknown",
        true,
      );
      this.recordNonDenial();
      freezeApprovedEvent(event);
      return undefined;
    }

    this.recordReview(
      ctx,
      action,
      "human_denied",
      freshReview ?? quickScore,
      freshReview?.hazard ?? quickScore?.impact ?? "unknown",
      true,
    );
    const denialState = this.recordDenial();
    const breakerTripped = denialState.tripped;
    if (breakerTripped) {
      this.breakerTripped = true;
      ctx.abort();
    }
    const reviewSummary = freshReview
      ? `The isolated reviewer recommended ${formatLabel(freshReview.recommendation)} with ${formatPercent(freshReview.recommendationConfidence)} confidence.`
      : `Automatic review was unavailable: ${safeErrorMessage(freshError)}`;
    const breaker = breakerTripped
      ? ` Safety circuit breaker tripped with ${this.consecutiveDenials} consecutive denials and ${denialState.recentDenials} denials in the last ${DENIAL_WINDOW_SIZE} reviews; stop this turn.`
      : "";

    return {
      block: true,
      terminate: breakerTripped,
      reason:
        `The human denied this exact bash action. ${reviewSummary}${breaker} ` +
        "Do not retry, rephrase, split, or pursue the same outcome indirectly. Continue only with a materially safer alternative; otherwise stop and ask the human.",
    };
  }

  finishToolCall(toolCallId: string): void {
    const pending = this.pendingScores.get(toolCallId);
    pending?.controller.abort();
    this.pendingScores.delete(toolCallId);
  }

  dispose(): void {
    for (const pending of this.pendingScores.values()) {
      pending.controller.abort();
    }
    this.pendingScores.clear();
  }

  private createPendingScore(
    action: BashAction,
    ctx: ExtensionContext,
    client: EvaluationClient,
  ): PendingScore {
    const controller = new AbortController();
    const context = this.buildContext(ctx, action);
    const signal = ctx.signal
      ? AbortSignal.any([controller.signal, ctx.signal])
      : controller.signal;
    const result = scoreActionRisk(
      client,
      context,
      this.config,
      signal,
    )
      .then((score) => ({ score }))
      .catch((error) => ({ error: asError(error) }));

    return {
      action,
      actionHash: actionFingerprint(action),
      authorizationHash: authorizationFingerprint(ctx),
      startedAt: Date.now(),
      controller,
      result,
    };
  }

  private buildContext(
    ctx: ExtensionContext,
    action: BashAction,
  ): ReviewContext {
    const actionHash = actionFingerprint(action);
    const authorizationHash = authorizationFingerprint(ctx);
    const matchingReviews = this.reviews.filter(
      (review) =>
        review.actionHash === actionHash &&
        review.authorizationHash === authorizationHash,
    );
    return buildReviewContext(
      ctx,
      action.command,
      matchingReviews,
      this.config,
      action.timeout,
    );
  }

  private recordReview(
    ctx: ExtensionContext,
    action: BashAction,
    decision: ReviewEvidence["decision"],
    review: QuickRiskScore | FreshReview | undefined,
    hazard: string,
    persist: boolean,
  ): void {
    const evidence: ReviewEvidence = {
      actionHash: actionFingerprint(action),
      authorizationHash: authorizationFingerprint(ctx),
      decision,
      dangerousProbability: review?.dangerousProbability ?? 1,
      hazard,
      timestamp: new Date().toISOString(),
    };
    this.reviews.push(evidence);
    this.trimReviews();
    if (persist) this.persistReview?.(evidence);
  }

  private trimReviews(): void {
    if (this.reviews.length > MAX_IN_MEMORY_REVIEWS) {
      this.reviews.splice(0, this.reviews.length - MAX_IN_MEMORY_REVIEWS);
    }
  }

  private recordNonDenial(): void {
    this.consecutiveDenials = 0;
    this.recordDenialWindow(false);
  }

  private recordDenial(): { tripped: boolean; recentDenials: number } {
    this.consecutiveDenials += 1;
    this.recordDenialWindow(true);
    const recentDenials = this.recentDenials.filter(Boolean).length;
    return {
      tripped:
        this.consecutiveDenials >= MAX_CONSECUTIVE_DENIALS ||
        recentDenials >= MAX_RECENT_DENIALS,
      recentDenials,
    };
  }

  private recordDenialWindow(denied: boolean): void {
    this.recentDenials.push(denied);
    if (this.recentDenials.length > DENIAL_WINDOW_SIZE) {
      this.recentDenials.shift();
    }
  }
}

export function readConfig(
  env: NodeJS.ProcessEnv = process.env,
): ApproveForMeConfig {
  return {
    enabled: !isFalse(env.PI_APPROVE_FOR_ME),
    model: env.PI_APPROVE_FOR_ME_MODEL?.trim() || DEFAULT_MODEL,
    riskThreshold: parseBoundedNumber(
      env.PI_APPROVE_FOR_ME_RISK_THRESHOLD,
      DEFAULT_RISK_THRESHOLD,
      0,
      1,
    ),
    minReviewerConfidence: parseBoundedNumber(
      env.PI_APPROVE_FOR_ME_MIN_REVIEWER_CONFIDENCE,
      DEFAULT_REVIEWER_CONFIDENCE,
      0,
      1,
    ),
    timeoutMs: parsePositiveInteger(
      env.PI_APPROVE_FOR_ME_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
    ),
    maxCommandChars: Math.min(
      parsePositiveInteger(
        env.PI_APPROVE_FOR_ME_MAX_COMMAND_CHARS,
        DEFAULT_MAX_COMMAND_CHARS,
      ),
      MAX_PROMPT_COMMAND_CHARS,
    ),
    maxScoreAgeMs: parsePositiveInteger(
      env.PI_APPROVE_FOR_ME_MAX_SCORE_AGE_MS,
      DEFAULT_MAX_SCORE_AGE_MS,
    ),
    maxMessageChars: parsePositiveInteger(
      env.PI_APPROVE_FOR_ME_MAX_MESSAGE_CONTEXT_CHARS,
      DEFAULT_MAX_MESSAGE_CONTEXT_CHARS,
    ),
    maxToolChars: parsePositiveInteger(
      env.PI_APPROVE_FOR_ME_MAX_TOOL_CONTEXT_CHARS,
      DEFAULT_MAX_TOOL_CONTEXT_CHARS,
    ),
    maxEntryChars: parsePositiveInteger(
      env.PI_APPROVE_FOR_ME_MAX_CONTEXT_ENTRY_CHARS,
      DEFAULT_MAX_CONTEXT_ENTRY_CHARS,
    ),
    maxRecentNonUserEntries: parsePositiveInteger(
      env.PI_APPROVE_FOR_ME_MAX_RECENT_NON_USER_ENTRIES,
      DEFAULT_MAX_RECENT_NON_USER_ENTRIES,
    ),
    maxPreviousReviews: parsePositiveInteger(
      env.PI_APPROVE_FOR_ME_MAX_PREVIOUS_REVIEWS,
      DEFAULT_MAX_PREVIOUS_REVIEWS,
    ),
    includeToolOutputs: !isFalse(
      env.PI_APPROVE_FOR_ME_INCLUDE_TOOL_OUTPUTS,
    ),
    additionalPolicy:
      env.PI_APPROVE_FOR_ME_POLICY?.trim() || undefined,
    baseURL:
      env.PI_APPROVE_FOR_ME_BASE_URL?.trim() ||
      env.TYPESAFE_BASE_URL?.trim() ||
      undefined,
  };
}

function createTypeSafeClient(config: ApproveForMeConfig): EvaluationClient {
  const apiKey =
    process.env.TYPESAFE_API_KEY?.trim() ||
    process.env.TYPESAFE_AI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("TYPESAFE_API_KEY is not set. Export it before starting Pi.");
  }
  return new TypeSafeClient({
    apiKey,
    baseURL: config.baseURL,
    defaultModel: config.model,
    timeout: config.timeoutMs,
  });
}

function getBashAction(input: unknown): BashAction | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = input as { command?: unknown; timeout?: unknown };
  if (typeof value.command !== "string" || !value.command.trim()) {
    return undefined;
  }
  const action: BashAction = { command: value.command };
  if (
    typeof value.timeout === "number" &&
    Number.isFinite(value.timeout) &&
    value.timeout > 0
  ) {
    action.timeout = value.timeout;
  }
  return action;
}

function actionFingerprint(action: BashAction): string {
  return commandFingerprint(
    JSON.stringify({
      command: action.command,
      timeout: action.timeout ?? null,
    }),
  );
}

function freezeApprovedEvent(event: ToolCallEvent): void {
  if (event.input && typeof event.input === "object") {
    Object.freeze(event.input);
  }
  Object.freeze(event);
}

function formatApprovalPrompt(
  command: string,
  cwd: string,
  timeout: number | undefined,
  quick: QuickRiskScore | undefined,
  fresh: FreshReview | undefined,
  error: Error | undefined,
  evidenceInvalidated: boolean,
): string {
  const assessment = fresh
    ? [
        `Reviewer recommendation: ${formatLabel(fresh.recommendation)} (${formatPercent(fresh.recommendationConfidence)} confidence)`,
        `Dangerous-risk probability: ${formatPercent(fresh.dangerousProbability)}`,
        `Primary hazard: ${formatLabel(fresh.hazard)}${formatOptionalConfidence(fresh.hazardConfidence)}`,
        `Goal aligned: ${formatPercent(fresh.goalAlignedProbability)}`,
        `Explicitly authorized: ${formatPercent(fresh.explicitlyAuthorizedProbability)}`,
        `Context sufficient: ${formatPercent(fresh.contextSufficientProbability)}`,
        ...(quick
          ? [
              `Fast risk score: ${formatPercent(quick.dangerousProbability)} (${formatLabel(quick.impact)})`,
            ]
          : []),
      ]
    : [
        "TypeSafe could not complete a fresh safety review.",
        `Reason: ${safeErrorMessage(error)}`,
        "Fail-safe policy requires human approval.",
      ];

  if (evidenceInvalidated) {
    assessment.push(
      "The fast score was not reused because its action, authorization, or age changed.",
    );
  }

  return [
    ...assessment,
    `Working directory: ${escapeForDisplay(cwd)}`,
    `Timeout: ${timeout === undefined ? "Pi default" : `${timeout} seconds`}`,
    "",
    "Command:",
    escapeForDisplay(command),
    "",
    "Approve this exact command for one execution?",
  ].join("\n");
}

function formatHeadlessBlockedReason(
  quick: QuickRiskScore | undefined,
  fresh: FreshReview,
): string {
  const quickText = quick
    ? ` Fast score: ${formatPercent(quick.dangerousProbability)}.`
    : "";
  return `Bash command blocked pending human approval: the fresh reviewer recommended ${formatLabel(fresh.recommendation)} with ${formatPercent(fresh.recommendationConfidence)} confidence and ${formatPercent(fresh.dangerousProbability)} dangerous risk.${quickText} No interactive UI is available.`;
}

function block(reason: string): GuardianToolCallResult {
  return { block: true, reason };
}

function formatLabel(value: string): string {
  return value.replaceAll("_", " ");
}

function formatOptionalConfidence(value: number | undefined): string {
  return value === undefined ? "" : ` (${formatPercent(value)} confidence)`;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function safeErrorMessage(error: Error | undefined): string {
  return sanitizeLine(error?.message || "unknown error").slice(0, 300);
}

function sanitizeLine(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F]+/g, " ").trim();
}

function escapeForDisplay(value: string): string {
  let escaped = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) as number;
    if (character === "\n") {
      escaped += "\n";
    } else if (codePoint >= 0x20 && codePoint !== 0x7f && !isBidiControl(codePoint)) {
      escaped += character;
    } else if (codePoint <= 0xff) {
      escaped += `\\x${codePoint.toString(16).padStart(2, "0")}`;
    } else {
      escaped += `\\u{${codePoint.toString(16)}}`;
    }
  }
  return escaped;
}

function isBidiControl(codePoint: number): boolean {
  return (
    (codePoint >= 0x061c && codePoint <= 0x061c) ||
    (codePoint >= 0x200e && codePoint <= 0x200f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

function isReviewEvidence(value: unknown): value is ReviewEvidence {
  if (!value || typeof value !== "object") return false;
  const review = value as Partial<ReviewEvidence>;
  return (
    typeof review.actionHash === "string" &&
    /^[a-f0-9]{64}$/.test(review.actionHash) &&
    typeof review.authorizationHash === "string" &&
    /^[a-f0-9]{64}$/.test(review.authorizationHash) &&
    ["auto_allowed", "human_approved", "human_denied"].includes(
      review.decision ?? "",
    ) &&
    typeof review.dangerousProbability === "number" &&
    Number.isFinite(review.dangerousProbability) &&
    review.dangerousProbability >= 0 &&
    review.dangerousProbability <= 1 &&
    typeof review.hazard === "string" &&
    review.hazard.length <= 100 &&
    typeof review.timestamp === "string" &&
    Number.isFinite(Date.parse(review.timestamp))
  );
}

function isFalse(value: string | undefined): boolean {
  return ["0", "false", "off", "no"].includes(
    value?.trim().toLowerCase() ?? "",
  );
}

function parseBoundedNumber(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
