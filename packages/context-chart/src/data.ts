import type { AgentMessage, AssistantMessage } from "@mariozechner/pi-ai";
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

export type Snapshot = {
	version: number;
	turn: number;
	systemInstructions: number;
	userInput: number;
	agentOutput: number;
	tools: number;
	memory: number;
	total: number;
	source: "recorded" | "live";
	turnLabel?: string;
	summary?: string;
	timestamp?: number;
	toolDetails?: ToolDetail[];
};

export type UsageTotals = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
};

export type SharedState = {
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

export function computeSharedState(ctx: ExtensionContext, event?: ContextEvent): SharedState {
	const recordedSnapshots = buildRecordedSnapshots(ctx);
	const liveSnapshot = event ? buildLiveSnapshot(event, ctx) : null;
	const currentSnapshot = buildCurrentContextSnapshot(ctx);
	const usage = collectUsage(ctx);
	const contextUsage = ctx.getContextUsage();
	const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? null;
	return { recordedSnapshots, liveSnapshot, currentSnapshot, usage, contextUsage, contextWindow };
}

export function buildChartPayload(state: SharedState, ctx: ExtensionContext): ChartPayload {
	const points = mergeSnapshots(state.recordedSnapshots, state.liveSnapshot);
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
	const canTrustUsage = !state.liveSnapshot && typeof state.contextUsage?.tokens === "number";
	const actualTokens = canTrustUsage ? state.contextUsage?.tokens ?? null : null;
	const tokens = actualTokens ?? estimated.total;
	const percent = canTrustUsage
		? state.contextUsage?.percent ??
		  (state.contextWindow && actualTokens !== null ? (actualTokens / state.contextWindow) * 100 : null)
		: state.contextWindow && tokens > 0
			? (tokens / state.contextWindow) * 100
			: null;

	const breakdown: FooterBreakdown = {
		systemInstructions: estimated.systemInstructions,
		userInput: estimated.userInput,
		agentOutput: estimated.agentOutput,
		tools: estimated.tools,
		memory: estimated.memory,
		total: estimated.total,
		turns: countTurns(state),
		approximate: !canTrustUsage,
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

function buildRecordedSnapshots(ctx: ExtensionContext): Snapshot[] {
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
		const toolNames = extractToolNames(entry.message);
		const toolDetails = extractToolDetails(branch, i);
		const context = buildSessionContext(entries, entry.parentId ?? null, byId);
		snapshots.push({
			...buildSnapshot(context.messages, systemPrompt, turn, "recorded"),
			turnLabel: toolNames.length > 0 ? (toolNames.length === 1 ? "Tool call" : "Tool calls") : "User message",
			summary: buildTurnSummary(lastUserText, toolNames),
			timestamp: safeTimestamp(entry.timestamp),
			toolDetails: toolDetails.length > 0 ? toolDetails : undefined,
		});
		lastUserText = "";
	}

	return snapshots;
}

function buildLiveSnapshot(event: ContextEvent, ctx: ExtensionContext): Snapshot {
	const branch = ctx.sessionManager.getBranch();
	const nextTurn = countAssistantMessages(branch) + 1;
	const snapshot = buildSnapshot(event.messages, ctx.getSystemPrompt() ?? "", nextTurn, "live");

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

function buildCurrentContextSnapshot(ctx: ExtensionContext): Snapshot {
	const entries = ctx.sessionManager.getEntries() as SessionEntry[];
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const currentContext = buildSessionContext(entries, ctx.sessionManager.getLeafId(), byId);
	const currentTurn = countAssistantMessages(ctx.sessionManager.getBranch());
	return buildSnapshot(currentContext.messages, ctx.getSystemPrompt() ?? "", currentTurn, "recorded");
}

function buildSnapshot(messages: AgentMessage[], systemPrompt: string, turn: number, source: Snapshot["source"]): Snapshot {
	const snapshot: Snapshot = {
		version: EXTENSION_SNAPSHOT_VERSION,
		turn,
		systemInstructions: estimateTextTokens(systemPrompt),
		userInput: 0,
		agentOutput: 0,
		tools: 0,
		memory: 0,
		total: 0,
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
