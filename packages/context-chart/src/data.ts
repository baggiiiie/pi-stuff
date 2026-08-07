import type { AgentMessage, AssistantMessage, Usage } from "@mariozechner/pi-ai";
import {
	buildSessionContext,
	estimateTokens,
	type ContextEvent,
	type ContextUsage,
	type ExtensionContext,
	type SessionEntry,
} from "@mariozechner/pi-coding-agent";

const EXTENSION_SNAPSHOT_VERSION = 1;

export type ToolDetail = {
	name: string;
	args?: string;
	result: string;
	isError: boolean;
};

/** A collapsible section shown in the turn 0 detail overlay. */
export type ContextSection = {
	title: string;
	tokens: number;
	content: string;
};

/** Minimal tool definition shape (subset of pi's ToolInfo). */
export type ToolDef = {
	name: string;
	description?: string;
	parameters?: unknown;
	source?: string;
};

export type Snapshot = {
	version: number;
	turn: number;
	systemInstructions: number;
	userInput: number;
	agentOutput: number;
	tools: number;
	memory: number;
	total: number;
	turnPrice: number | null;
	source: "recorded" | "live";
	turnLabel?: string;
	summary?: string;
	timestamp?: number;
	toolDetails?: ToolDetail[];
	/** Populated for turn 0: breakdown of the base context (system prompt, skills, tool defs). */
	contextDetails?: ContextSection[];
};

export type UsageTotals = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
};

type PricingModel = {
	id: string;
	provider: string;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
};

export type SharedState = {
	turn0Snapshot: Snapshot;
	recordedSnapshots: Snapshot[];
	liveSnapshot: Snapshot | null;
	currentSnapshot: Snapshot;
	usage: UsageTotals;
	contextUsage: ContextUsage | undefined;
	contextWindow: number | null;
};

export type ChartPayload = {
	points: Snapshot[];
	meta: {
		model: string | null;
		sessionName: string | null;
		sessionFile: string | null;
		contextWindow: number | null;
		currentTotal: number;
		currentPercent: number | null;
		usage: UsageTotals;
		updatedAt: number;
	};
};

export type FooterBreakdown = {
	systemInstructions: number;
	userInput: number;
	agentOutput: number;
	tools: number;
	memory: number;
	total: number;
	turns: number;
	approximate: boolean;
	source: "recorded" | "live";
};

export type FooterViewModel = {
	contextUsage: ContextUsage | undefined;
	contextWindow: number | null;
	tokens: number | null;
	percent: number | null;
	breakdown: FooterBreakdown;
	usage: UsageTotals;
};

export function computeSharedState(ctx: ExtensionContext, event?: ContextEvent, tools: ToolDef[] = []): SharedState {
	const toolSections = buildToolSections(tools);
	const toolDefTokens = toolSections.reduce((sum, section) => sum + section.tokens, 0);
	const turn0Snapshot = buildTurn0Snapshot(ctx, toolSections, toolDefTokens);
	const recordedSnapshots = buildRecordedSnapshots(ctx, toolDefTokens);
	const liveSnapshot = event ? buildLiveSnapshot(event, ctx, toolDefTokens) : null;
	const currentSnapshot = buildCurrentContextSnapshot(ctx, toolDefTokens);
	const usage = collectUsage(ctx);
	const contextUsage = ctx.getContextUsage();
	const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? null;
	return { turn0Snapshot, recordedSnapshots, liveSnapshot, currentSnapshot, usage, contextUsage, contextWindow };
}

export function buildChartPayload(state: SharedState, ctx: ExtensionContext): ChartPayload {
	const points = [state.turn0Snapshot, ...mergeSnapshots(state.recordedSnapshots, state.liveSnapshot)];
	const current = state.liveSnapshot ?? state.currentSnapshot;
	const currentPercent =
		state.contextWindow && current.total > 0 ? (current.total / state.contextWindow) * 100 : null;

	return {
		points,
		meta: {
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
			sessionName: ctx.sessionManager.getSessionName() ?? null,
			sessionFile: ctx.sessionManager.getSessionFile() ?? null,
			contextWindow: state.contextWindow,
			currentTotal: current.total,
			currentPercent,
			usage: state.usage,
			updatedAt: Date.now(),
		},
	};
}

export function buildFooterViewModel(state: SharedState): FooterViewModel {
	const estimated = state.liveSnapshot ?? state.currentSnapshot;
	const actualTokens = typeof state.contextUsage?.tokens === "number" ? state.contextUsage.tokens : null;

	let tokens: number | null;
	let percent: number | null;
	let approximate: boolean;

	if (!state.liveSnapshot && actualTokens !== null) {
		// Idle: trust the exact prompt-token count reported by the last API response.
		tokens = actualTokens;
		percent =
			state.contextUsage?.percent ??
			(state.contextWindow ? (actualTokens / state.contextWindow) * 100 : null);
		approximate = false;
	} else if (state.liveSnapshot && actualTokens !== null) {
		// Live turn: the real token count for the in-flight request isn't known yet.
		// Local estimation systematically undercounts (it ignores provider-side message
		// wrapping / tool-schema serialization overhead), so switching straight to the
		// raw estimate makes the footer visibly drop the moment a message is sent.
		// Calibrate the live estimate against the last trusted count using the offset
		// between the actual count and our estimate of that same recorded context.
		const offset = Math.max(0, actualTokens - state.currentSnapshot.total);
		tokens = estimated.total + offset;
		percent = state.contextWindow && tokens > 0 ? (tokens / state.contextWindow) * 100 : null;
		approximate = true;
	} else {
		// No trusted usage yet (e.g. right after compaction): pure local estimate.
		tokens = estimated.total;
		percent = state.contextWindow && tokens > 0 ? (tokens / state.contextWindow) * 100 : null;
		approximate = true;
	}

	const breakdown: FooterBreakdown = {
		systemInstructions: estimated.systemInstructions,
		userInput: estimated.userInput,
		agentOutput: estimated.agentOutput,
		tools: estimated.tools,
		memory: estimated.memory,
		total: estimated.total,
		turns: countTurns(state),
		approximate,
		source: estimated.source,
	};

	return {
		contextUsage: state.contextUsage,
		contextWindow: state.contextWindow,
		tokens,
		percent,
		breakdown: scaleBreakdownToTotal(breakdown, tokens),
		usage: state.usage,
	};
}

function countTurns(state: SharedState): number {
	const recorded = state.recordedSnapshots.length;
	return state.liveSnapshot ? recorded + 1 : recorded;
}

function buildTurn0Snapshot(ctx: ExtensionContext, toolSections: ContextSection[], toolDefTokens: number): Snapshot {
	const systemPrompt = ctx.getSystemPrompt() ?? "";
	const promptSections = buildSystemPromptSections(systemPrompt);
	const systemPromptTokens = estimateTextTokens(systemPrompt);
	const systemInstructions = systemPromptTokens + toolDefTokens;

	return {
		version: EXTENSION_SNAPSHOT_VERSION,
		turn: 0,
		systemInstructions,
		userInput: 0,
		agentOutput: 0,
		tools: 0,
		memory: 0,
		total: systemInstructions,
		turnPrice: null,
		source: "recorded",
		turnLabel: "Initial context",
		summary: buildTurn0Summary(promptSections, toolSections),
		contextDetails: [...promptSections, ...toolSections],
	};
}

function buildTurn0Summary(promptSections: ContextSection[], toolSections: ContextSection[]): string {
	const parts: string[] = ["System prompt"];
	if (promptSections.some((section) => section.title === "Skills")) parts.push("skills");
	if (toolSections.length > 0) parts.push(`${toolSections.length} tool${toolSections.length === 1 ? "" : "s"}`);
	return parts.join(" · ");
}

/** Split the resolved system prompt into labelled sections for the detail overlay. */
function buildSystemPromptSections(systemPrompt: string): ContextSection[] {
	if (!systemPrompt.trim()) return [];

	const sections: ContextSection[] = [];
	let rest = systemPrompt;

	// Peel off the trailing "Current date/working directory" footer so it stays
	// attributed to the base prompt (it is appended after the skills block).
	let footer = "";
	const footerIndex = rest.lastIndexOf("\nCurrent date:");
	if (footerIndex >= 0) {
		footer = rest.slice(footerIndex).trim();
		rest = rest.slice(0, footerIndex);
	}

	// Extract the skills block (appears after project context in the prompt).
	let skillsText = "";
	const skillsIndex = rest.indexOf("<available_skills>");
	if (skillsIndex >= 0) {
		// Skills section starts a couple lines before the tag (with intro text).
		const introIndex = rest.lastIndexOf("\n\nThe following skills provide", skillsIndex);
		const start = introIndex >= 0 ? introIndex : skillsIndex;
		const endTag = rest.indexOf("</available_skills>", skillsIndex);
		const end = endTag >= 0 ? endTag + "</available_skills>".length : rest.length;
		skillsText = rest.slice(start, end).trim();
		rest = rest.slice(0, start) + rest.slice(end);
	}

	let contextText = "";
	const contextIndex = rest.indexOf("# Project Context");
	if (contextIndex >= 0) {
		contextText = rest.slice(contextIndex).trim();
		rest = rest.slice(0, contextIndex);
	}

	const baseText = [rest.trim(), footer].filter(Boolean).join("\n");
	sections.push({ title: "System prompt", tokens: estimateTextTokens(baseText), content: baseText });
	if (contextText) sections.push({ title: "Project context", tokens: estimateTextTokens(contextText), content: contextText });
	if (skillsText) sections.push({ title: "Skills", tokens: estimateTextTokens(skillsText), content: skillsText });
	return sections;
}

/** Build one collapsible section per active tool definition. */
function buildToolSections(tools: ToolDef[]): ContextSection[] {
	return tools.map((tool) => {
		const lines: string[] = [];
		if (tool.description) lines.push(tool.description.trim());
		if (tool.parameters !== undefined) {
			lines.push("", "Parameters:", safeStringify(tool.parameters));
		}
		const content = lines.join("\n");
		const schemaText = `${tool.name}\n${tool.description ?? ""}\n${safeStringify(tool.parameters ?? {})}`;
		return {
			title: `tool: ${tool.name}${tool.source ? ` (${tool.source})` : ""}`,
			tokens: estimateTextTokens(schemaText),
			content: content || "(no schema)",
		};
	});
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function buildRecordedSnapshots(ctx: ExtensionContext, toolDefTokens: number): Snapshot[] {
	const branch = ctx.sessionManager.getBranch();
	const entries = ctx.sessionManager.getEntries() as SessionEntry[];
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const systemPrompt = ctx.getSystemPrompt() ?? "";
	const snapshots: Snapshot[] = [];
	let turn = 0;
	let lastUserText = "";

	for (let i = 0; i < branch.length; i++) {
		const entry = branch[i];
		if (entry.type === "message" && entry.message.role === "user") {
			lastUserText = extractFirstText(entry.message);
		}
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		turn += 1;
		const assistantMessage = entry.message as AssistantMessage;
		const toolNames = extractToolNames(entry.message);
		const toolDetails = extractToolDetails(branch, i);
		const context = buildSessionContext(entries, entry.parentId ?? null, byId);
		snapshots.push({
			...buildSnapshot(context.messages, systemPrompt, turn, "recorded", toolDefTokens),
			turnPrice: extractTurnPrice(assistantMessage, ctx.model),
			turnLabel: toolNames.length > 0 ? (toolNames.length === 1 ? "Tool call" : "Tool calls") : "User message",
			summary: buildTurnSummary(lastUserText, toolNames),
			timestamp: safeTimestamp(entry.timestamp),
			toolDetails: toolDetails.length > 0 ? toolDetails : undefined,
		});
		lastUserText = "";
	}

	return snapshots;
}

function buildLiveSnapshot(event: ContextEvent, ctx: ExtensionContext, toolDefTokens: number): Snapshot {
	const branch = ctx.sessionManager.getBranch();
	const nextTurn = countAssistantMessages(branch) + 1;
	const snapshot = buildSnapshot(event.messages, ctx.getSystemPrompt() ?? "", nextTurn, "live", toolDefTokens);

	let lastUserText = "";
	for (let i = event.messages.length - 1; i >= 0; i--) {
		if (event.messages[i].role === "user") {
			lastUserText = extractFirstText(event.messages[i]);
			break;
		}
	}
	snapshot.turnLabel = "User message";
	snapshot.summary = buildTurnSummary(lastUserText, []);

	return snapshot;
}

function buildCurrentContextSnapshot(ctx: ExtensionContext, toolDefTokens: number): Snapshot {
	const entries = ctx.sessionManager.getEntries() as SessionEntry[];
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const currentContext = buildSessionContext(entries, ctx.sessionManager.getLeafId(), byId);
	const currentTurn = countAssistantMessages(ctx.sessionManager.getBranch());
	return buildSnapshot(currentContext.messages, ctx.getSystemPrompt() ?? "", currentTurn, "recorded", toolDefTokens);
}

function buildSnapshot(
	messages: AgentMessage[],
	systemPrompt: string,
	turn: number,
	source: Snapshot["source"],
	toolDefTokens = 0,
): Snapshot {
	const snapshot: Snapshot = {
		version: EXTENSION_SNAPSHOT_VERSION,
		turn,
		systemInstructions: estimateTextTokens(systemPrompt) + toolDefTokens,
		userInput: 0,
		agentOutput: 0,
		tools: 0,
		memory: 0,
		total: 0,
		turnPrice: null,
		source,
	};

	for (const message of messages) {
		const tokens = safeEstimateMessage(message);
		switch (message.role) {
			case "user":
				snapshot.userInput += tokens;
				break;
			case "assistant":
				snapshot.agentOutput += tokens;
				break;
			case "toolResult":
			case "bashExecution":
				snapshot.tools += tokens;
				break;
			case "compactionSummary":
			case "branchSummary":
			case "custom":
				snapshot.memory += tokens;
				break;
			default:
				snapshot.memory += tokens;
		}
	}

	snapshot.total =
		snapshot.systemInstructions +
		snapshot.userInput +
		snapshot.agentOutput +
		snapshot.tools +
		snapshot.memory;

	return snapshot;
}

function mergeSnapshots(recorded: Snapshot[], live: Snapshot | null): Snapshot[] {
	const merged = [...recorded];
	if (live) {
		const index = merged.findIndex((point) => point.turn === live.turn);
		if (index >= 0) merged[index] = live;
		else merged.push(live);
	}
	return merged.sort((a, b) => a.turn - b.turn);
}

function collectUsage(ctx: ExtensionContext): UsageTotals {
	const usage: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const message = entry.message as AssistantMessage;
		usage.input += message.usage?.input ?? 0;
		usage.output += message.usage?.output ?? 0;
		usage.cacheRead += message.usage?.cacheRead ?? 0;
		usage.cacheWrite += message.usage?.cacheWrite ?? 0;
		usage.cost += message.usage?.cost?.total ?? 0;
	}
	return usage;
}

function extractTurnPrice(message: AssistantMessage, currentModel: PricingModel | null | undefined): number | null {
	const usage = message.usage;
	if (!usage) return null;
	const tokens = normalizeUsageTokens(usage);
	const tokenTotal = tokens ? tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite : null;

	const reported = normalizePrice(usage.cost?.total);
	if (reported !== null && reported > 0) return reported;

	const reportedComponents = sumCost(usage.cost);
	if (reportedComponents > 0) return reportedComponents;
	if (tokenTotal === 0) return 0;

	const model = resolvePricingModel(message, currentModel);
	if (!model || !hasAnyPositiveRate(model.cost)) return null;
	if (!tokens) return null;

	const price =
		(model.cost.input * tokens.input) / 1_000_000 +
		(model.cost.output * tokens.output) / 1_000_000 +
		(model.cost.cacheRead * tokens.cacheRead) / 1_000_000 +
		(model.cost.cacheWrite * tokens.cacheWrite) / 1_000_000;
	return normalizePrice(price);
}

function resolvePricingModel(message: AssistantMessage, currentModel: PricingModel | null | undefined): PricingModel | undefined {
	if (!currentModel || currentModel.provider !== message.provider) return undefined;
	if (currentModel.id !== message.model && currentModel.id !== message.responseModel) return undefined;
	return currentModel;
}

function normalizePrice(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function sumCost(cost: Usage["cost"] | undefined): number {
	if (!cost) return 0;
	return (
		(normalizePrice(cost.input) ?? 0) +
		(normalizePrice(cost.output) ?? 0) +
		(normalizePrice(cost.cacheRead) ?? 0) +
		(normalizePrice(cost.cacheWrite) ?? 0)
	);
}

function hasAnyPositiveRate(cost: { input: number; output: number; cacheRead: number; cacheWrite: number }): boolean {
	return cost.input > 0 || cost.output > 0 || cost.cacheRead > 0 || cost.cacheWrite > 0;
}

function normalizeUsageTokens(usage: Usage): Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite"> | null {
	const input = normalizeTokenCount(usage.input);
	const output = normalizeTokenCount(usage.output);
	const cacheRead = normalizeTokenCount(usage.cacheRead);
	const cacheWrite = normalizeTokenCount(usage.cacheWrite);
	if (input === null && output === null && cacheRead === null && cacheWrite === null) return null;
	return {
		input: input ?? 0,
		output: output ?? 0,
		cacheRead: cacheRead ?? 0,
		cacheWrite: cacheWrite ?? 0,
	};
}

function normalizeTokenCount(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function countAssistantMessages(entries: SessionEntry[]): number {
	let count = 0;
	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "assistant") count += 1;
	}
	return count;
}

function scaleBreakdownToTotal(breakdown: FooterBreakdown, targetTotal: number | null): FooterBreakdown {
	if (targetTotal === null || targetTotal < 0 || breakdown.total <= 0) return breakdown;
	if (breakdown.total === targetTotal) return breakdown;

	const fields = [
		{ key: "systemInstructions", value: breakdown.systemInstructions },
		{ key: "userInput", value: breakdown.userInput },
		{ key: "agentOutput", value: breakdown.agentOutput },
		{ key: "tools", value: breakdown.tools },
		{ key: "memory", value: breakdown.memory },
	] as const;

	const scaled = fields.map((field) => {
		const raw = (field.value / breakdown.total) * targetTotal;
		const value = Math.floor(raw);
		return { key: field.key, value, remainder: raw - value };
	});

	let assigned = scaled.reduce((sum, field) => sum + field.value, 0);
	for (const field of [...scaled].sort((a, b) => b.remainder - a.remainder)) {
		if (assigned >= targetTotal) break;
		field.value += 1;
		assigned += 1;
	}

	const next = { ...breakdown, total: targetTotal };
	for (const field of scaled) {
		(next as unknown as Record<string, number>)[field.key] = field.value;
	}
	return next;
}

function estimateTextTokens(text: string): number {
	if (!text.trim()) return 0;
	return safeEstimateMessage({ role: "user", content: text, timestamp: Date.now() } as AgentMessage);
}

function safeEstimateMessage(message: AgentMessage): number {
	try {
		return Math.max(0, estimateTokens(message));
	} catch {
		return Math.max(0, Math.ceil(extractText(message).length / 4));
	}
}

function extractText(message: AgentMessage): string {
	const parts: string[] = [message.role];
	const anyMessage = message as any;

	if (typeof anyMessage.content === "string") {
		parts.push(anyMessage.content);
	} else if (Array.isArray(anyMessage.content)) {
		for (const block of anyMessage.content) {
			if (block.type === "text") parts.push(block.text ?? "");
			else if (block.type === "thinking") parts.push(block.thinking ?? "");
			else if (block.type === "toolCall") parts.push(block.name ?? "", JSON.stringify(block.arguments ?? {}));
			else parts.push(JSON.stringify(block));
		}
	}

	for (const key of ["toolName", "summary", "command", "customType"]) {
		if (typeof anyMessage[key] === "string") parts.push(anyMessage[key]);
	}

	return parts.join("\n");
}

function safeTimestamp(timestamp: string): number | undefined {
	const value = Date.parse(timestamp);
	return Number.isFinite(value) ? value : undefined;
}

function extractFirstText(message: AgentMessage): string {
	const anyMsg = message as any;
	if (typeof anyMsg.content === "string") return anyMsg.content.trim().replace(/\s+/g, " ");
	if (Array.isArray(anyMsg.content)) {
		for (const block of anyMsg.content) {
			if (block.type === "text" && block.text) return block.text.trim().replace(/\s+/g, " ");
		}
	}
	return "";
}

function extractToolNames(message: AgentMessage): string[] {
	const anyMsg = message as any;
	const names: string[] = [];
	if (Array.isArray(anyMsg.content)) {
		for (const block of anyMsg.content) {
			if (block.type === "toolCall" && block.name && !names.includes(block.name)) {
				names.push(block.name);
			}
		}
	}
	return names;
}

function extractToolDetails(branch: SessionEntry[], assistantIndex: number): ToolDetail[] {
	const assistantEntry = branch[assistantIndex];
	const argsById = new Map<string, string>();
	if (assistantEntry.type === "message") {
		const content = (assistantEntry.message as any).content;
		if (Array.isArray(content)) {
			for (const block of content) {
				if (block.type === "toolCall" && block.id) {
					argsById.set(block.id, JSON.stringify(block.arguments ?? {}, null, 2));
				}
			}
		}
	}

	const details: ToolDetail[] = [];
	for (let j = assistantIndex + 1; j < branch.length; j++) {
		const entry = branch[j];
		if (entry.type !== "message") continue;
		const msg = entry.message as any;
		if (msg.role === "toolResult") {
			const text = Array.isArray(msg.content)
				? msg.content
					.filter((b: any) => b.type === "text")
					.map((b: any) => b.text ?? "")
					.join("\n")
				: "";
			details.push({ name: msg.toolName ?? "unknown", args: argsById.get(msg.toolCallId), result: text, isError: !!msg.isError });
		} else if (msg.role === "bashExecution") {
			details.push({ name: "bash", args: msg.command ?? undefined, result: msg.output ?? "", isError: (msg.exitCode ?? 0) !== 0 });
		} else if (msg.role === "user" || msg.role === "assistant") {
			break;
		}
	}
	return details;
}

function buildTurnSummary(userText: string, toolNames: string[]): string {
	const parts: string[] = [];
	if (userText) {
		const truncated = userText.length > 80 ? userText.slice(0, 80) + "…" : userText;
		parts.push(`"${truncated}"`);
	}
	if (toolNames.length > 0) {
		parts.push(toolNames.join(", "));
	}
	return parts.join(" · ");
}

export function formatTokens(count: number): string {
	if (!Number.isFinite(count)) return "?";
	if (count < 1000) return `${Math.round(count)}`;
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}
