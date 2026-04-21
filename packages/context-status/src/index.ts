import type { AgentMessage, AssistantMessage } from "@mariozechner/pi-ai";
import {
	buildSessionContext,
	estimateTokens,
	type ContextEvent,
	type ContextUsage,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
} from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

const KEY = "context-status";
const DEFAULT_MODE = "status";
const STATUS_BAR_WIDTH = 16;
const FOOTER_BAR_WIDTH = 28;

type Mode = "off" | "status" | "footer";

type Breakdown = {
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

type UsageTotals = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
};

type ViewModel = {
	usage: ContextUsage | undefined;
	contextWindow: number | null;
	tokens: number | null;
	percent: number | null;
	breakdown: Breakdown;
};

export default function (pi: ExtensionAPI) {
	let mode = readMode(process.env.PI_CONTEXT_STATUS_MODE);
	let viewModel: ViewModel | null = null;

	const refreshFromContext = (ctx: ExtensionContext, liveMessages?: AgentMessage[]) => {
		viewModel = buildViewModel(ctx, liveMessages);
		applyUi(ctx);
	};

	const clearUi = (ctx: Pick<ExtensionContext, "ui">) => {
		ctx.ui.setStatus(KEY, undefined);
		ctx.ui.setFooter(undefined);
	};

	const applyUi = (ctx: ExtensionContext) => {
		if (mode === "off") {
			clearUi(ctx);
			return;
		}

		if (!viewModel) {
			viewModel = buildViewModel(ctx);
		}

		if (mode === "status") {
			ctx.ui.setFooter(undefined);
			ctx.ui.setStatus(KEY, buildStatusLine(viewModel, ctx.ui.theme));
			return;
		}

		ctx.ui.setStatus(KEY, undefined);
		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());
			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					return buildFooterLines(width, theme, footerData, ctx, viewModel ?? buildViewModel(ctx));
				},
			};
		});
	};

	pi.registerCommand(KEY, {
		description: "Show current context-window usage in the status line or footer",
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase();

			if (!command || command === "help") {
				ctx.ui.setWidget(KEY, [
					"/context-status",
					"",
					"Commands:",
					"  /context-status status   Show compact context info in the status line",
					"  /context-status footer   Show expanded context info in a custom footer",
					"  /context-status off      Disable context status UI",
					"  /context-status refresh  Recompute immediately",
					"  /context-status clear    Clear this help widget",
					"",
					`Current mode: ${mode}`,
					`Startup mode env: PI_CONTEXT_STATUS_MODE=${process.env.PI_CONTEXT_STATUS_MODE ?? DEFAULT_MODE}`,
				]);
				return;
			}

			if (["clear", "close", "hide"].includes(command)) {
				ctx.ui.setWidget(KEY, undefined);
				return;
			}

			if (command === "refresh") {
				refreshFromContext(ctx);
				ctx.ui.notify(`Context status refreshed (${mode})`, "info");
				return;
			}

			if (["off", "status", "footer"].includes(command)) {
				mode = command as Mode;
				refreshFromContext(ctx);
				ctx.ui.setWidget(KEY, undefined);
				ctx.ui.notify(`Context status mode: ${mode}`, "info");
				return;
			}

			ctx.ui.notify(`Unknown subcommand: ${args.trim()}. Try /context-status help`, "info");
		},
	});

	const handleSessionUpdate = (_event: unknown, ctx: ExtensionContext) => {
		refreshFromContext(ctx);
	};

	pi.on("session_start", handleSessionUpdate);
	pi.on("session_switch", handleSessionUpdate);
	pi.on("session_fork", handleSessionUpdate);
	pi.on("session_tree", handleSessionUpdate);
	pi.on("session_compact", handleSessionUpdate);
	pi.on("turn_end", handleSessionUpdate);
	pi.on("model_select", handleSessionUpdate);

	pi.on("context", (event: ContextEvent, ctx) => {
		refreshFromContext(ctx, event.messages);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		viewModel = null;
		clearUi(ctx);
		ctx.ui.setWidget(KEY, undefined);
	});
}

function buildViewModel(ctx: ExtensionContext, liveMessages?: AgentMessage[]): ViewModel {
	const estimatedBreakdown = liveMessages ? buildLiveBreakdown(liveMessages, ctx) : buildCurrentBreakdown(ctx);
	const usage = ctx.getContextUsage();
	const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? null;
	const canTrustUsage = !liveMessages && typeof usage?.tokens === "number";
	const actualTokens = canTrustUsage ? usage?.tokens ?? null : null;
	const tokens = actualTokens ?? estimatedBreakdown.total;
	const percent = canTrustUsage
		? (usage?.percent ?? (contextWindow && actualTokens !== null ? (actualTokens / contextWindow) * 100 : null))
		: contextWindow && tokens > 0
			? (tokens / contextWindow) * 100
			: null;

	return {
		usage,
		contextWindow,
		tokens,
		percent,
		breakdown: {
			...scaleBreakdownToTotal(estimatedBreakdown, tokens),
			approximate: !canTrustUsage,
		},
	};
}

function buildCurrentBreakdown(ctx: ExtensionContext): Breakdown {
	const entries = ctx.sessionManager.getEntries() as SessionEntry[];
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const currentContext = buildSessionContext(entries, ctx.sessionManager.getLeafId(), byId);
	const turns = countAssistantMessages(ctx.sessionManager.getBranch() as SessionEntry[]);
	return buildBreakdown(currentContext.messages, ctx.getSystemPrompt() ?? "", turns, "recorded");
}

function buildLiveBreakdown(messages: AgentMessage[], ctx: ExtensionContext): Breakdown {
	const turns = countAssistantMessages(ctx.sessionManager.getBranch() as SessionEntry[]) + 1;
	return buildBreakdown(messages, ctx.getSystemPrompt() ?? "", turns, "live");
}

function buildBreakdown(messages: AgentMessage[], systemPrompt: string, turns: number, source: Breakdown["source"]): Breakdown {
	const breakdown: Breakdown = {
		systemInstructions: estimateTextTokens(systemPrompt),
		userInput: 0,
		agentOutput: 0,
		tools: 0,
		memory: 0,
		total: 0,
		turns,
		approximate: false,
		source,
	};

	for (const message of messages) {
		const tokens = safeEstimateMessage(message);
		switch (message.role) {
			case "user":
				breakdown.userInput += tokens;
				break;
			case "assistant":
				breakdown.agentOutput += tokens;
				break;
			case "toolResult":
			case "bashExecution":
				breakdown.tools += tokens;
				break;
			case "compactionSummary":
			case "branchSummary":
			case "custom":
				breakdown.memory += tokens;
				break;
			default:
				breakdown.memory += tokens;
				break;
		}
	}

	breakdown.total =
		breakdown.systemInstructions +
		breakdown.userInput +
		breakdown.agentOutput +
		breakdown.tools +
		breakdown.memory;

	return breakdown;
}

function scaleBreakdownToTotal(breakdown: Breakdown, targetTotal: number | null): Breakdown {
	if (targetTotal === null || targetTotal < 0 || breakdown.total <= 0) {
		return breakdown;
	}
	if (breakdown.total === targetTotal) {
		return breakdown;
	}

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
		return {
			key: field.key,
			value,
			remainder: raw - value,
		};
	});

	let assigned = scaled.reduce((sum, field) => sum + field.value, 0);
	for (const field of [...scaled].sort((a, b) => b.remainder - a.remainder)) {
		if (assigned >= targetTotal) break;
		field.value += 1;
		assigned += 1;
	}

	const next = { ...breakdown, total: targetTotal };
	for (const field of scaled) {
		(next as Record<string, number>)[field.key] = field.value;
	}
	return next;
}

function buildStatusLine(view: ViewModel, theme: ExtensionContext["ui"]["theme"]): string {
	const pieces = [
		theme.fg("accent", "🧠"),
		theme.fg("dim", formatHeadline(view)),
		renderLegend(view.breakdown, theme),
		renderBar(view, theme, STATUS_BAR_WIDTH),
	].filter(Boolean);

	return pieces.join(theme.fg("dim", " • "));
}

function buildFooterLines(
	width: number,
	theme: ExtensionContext["ui"]["theme"],
	footerData: { getGitBranch(): string | null; getExtensionStatuses(): ReadonlyMap<string, string>; getAvailableProviderCount(): number },
	ctx: ExtensionContext,
	view: ViewModel,
): string[] {
	const lines: string[] = [];
	const cwd = formatCwd(ctx.cwd);
	const branch = footerData.getGitBranch();
	const sessionName = ctx.sessionManager.getSessionName();
	const leftTitle = [cwd, branch ? `(${branch})` : undefined, sessionName ? `• ${sessionName}` : undefined].filter(Boolean).join(" ");
	lines.push(truncateToWidth(theme.fg("dim", leftTitle), width, theme.fg("dim", "...")));

	const usage = collectUsage(ctx);
	const leftStats = buildUsageStats(usage, view, theme);
	const rightStats = buildModelLabel(ctx, footerData.getAvailableProviderCount(), theme);
	lines.push(joinLeftRight(leftStats, rightStats, width));

	const summaryPrefix = theme.fg("accent", "Context ");
	const summaryBody = theme.fg("dim", formatHeadline(view));
	const summaryLegend = renderLegend(view.breakdown, theme, "full");
	const summary = [summaryPrefix + summaryBody, summaryLegend].filter(Boolean).join(theme.fg("dim", " • "));
	lines.push(truncateToWidth(summary, width, theme.fg("dim", "...")));

	const barLabel = theme.fg("dim", `${view.breakdown.approximate ? "Estimated" : "Current"} mix `);
	const bar = barLabel + renderBar(view, theme, Math.max(10, Math.min(FOOTER_BAR_WIDTH, width - visibleWidth(barLabel) - 1)));
	lines.push(truncateToWidth(bar, width, theme.fg("dim", "...")));

	const otherStatuses = Array.from(footerData.getExtensionStatuses().entries())
		.filter(([key]) => key !== KEY)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, text]) => sanitizeStatusText(text));
	if (otherStatuses.length > 0) {
		lines.push(truncateToWidth(otherStatuses.join(" "), width, theme.fg("dim", "...")));
	}

	return lines;
}

function buildUsageStats(usage: UsageTotals, view: ViewModel, theme: ExtensionContext["ui"]["theme"]): string {
	const parts: string[] = [];
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(3)}`);
	parts.push(colorizePercent(view, theme));
	return theme.fg("dim", parts.join(" "));
}

function buildModelLabel(
	ctx: ExtensionContext,
	availableProviderCount: number,
	theme: ExtensionContext["ui"]["theme"],
): string {
	if (!ctx.model) {
		return theme.fg("dim", "no-model");
	}
	const providerPrefix = availableProviderCount > 1 ? `(${ctx.model.provider}) ` : "";
	return theme.fg("dim", `${providerPrefix}${ctx.model.id}`);
}

function joinLeftRight(left: string, right: string, width: number): string {
	const leftWidth = visibleWidth(left);
	const rightWidth = visibleWidth(right);
	if (leftWidth + 2 + rightWidth <= width) {
		return left + " ".repeat(Math.max(1, width - leftWidth - rightWidth)) + right;
	}

	const availableLeft = Math.max(1, width - rightWidth - 1);
	const truncatedLeft = truncateToWidth(left, availableLeft, "");
	const truncatedLeftWidth = visibleWidth(truncatedLeft);
	const padding = " ".repeat(Math.max(1, width - truncatedLeftWidth - rightWidth));
	return truncatedLeft + padding + right;
}

function renderLegend(
	breakdown: Breakdown,
	theme: ExtensionContext["ui"]["theme"],
	mode: "short" | "full" = "short",
): string {
	const entries = [
		colorizedToken(theme, "warning", mode === "full" ? "System " : "S", breakdown.systemInstructions),
		colorizedToken(theme, "accent", mode === "full" ? "User " : "U", breakdown.userInput),
		colorizedToken(theme, "success", mode === "full" ? "Agent " : "A", breakdown.agentOutput),
		colorizedToken(theme, "error", mode === "full" ? "Tools " : "T", breakdown.tools),
		colorizedToken(theme, "muted", mode === "full" ? "Carried context " : "C", breakdown.memory),
	];
	return entries.join(theme.fg("dim", " • "));
}

function renderBar(view: ViewModel, theme: ExtensionContext["ui"]["theme"], width: number): string {
	const contextWindow = view.contextWindow;
	const total = view.tokens ?? 0;
	if (!contextWindow || contextWindow <= 0 || width <= 0) {
		return theme.fg("dim", "[no window]");
	}

	const filled = clamp(Math.round((Math.min(total, contextWindow) / contextWindow) * width), 0, width);
	const segments = allocateBarSegments(view.breakdown, filled);
	const empty = theme.fg("dim", "░".repeat(Math.max(0, width - filled)));

	return [
		theme.fg("warning", "█".repeat(segments.systemInstructions)),
		theme.fg("accent", "█".repeat(segments.userInput)),
		theme.fg("success", "█".repeat(segments.agentOutput)),
		theme.fg("error", "█".repeat(segments.tools)),
		theme.fg("muted", "█".repeat(segments.memory)),
		empty,
	].join("");
}

function allocateBarSegments(breakdown: Breakdown, filled: number) {
	const parts = [
		{ key: "systemInstructions", value: breakdown.systemInstructions },
		{ key: "userInput", value: breakdown.userInput },
		{ key: "agentOutput", value: breakdown.agentOutput },
		{ key: "tools", value: breakdown.tools },
		{ key: "memory", value: breakdown.memory },
	] as const;

	if (filled <= 0 || breakdown.total <= 0) {
		return { systemInstructions: 0, userInput: 0, agentOutput: 0, tools: 0, memory: 0 };
	}

	const scaled = parts.map((part) => {
		const raw = (part.value / breakdown.total) * filled;
		const value = Math.floor(raw);
		return { key: part.key, value, remainder: raw - value };
	});

	let assigned = scaled.reduce((sum, part) => sum + part.value, 0);
	for (const part of [...scaled].sort((a, b) => b.remainder - a.remainder)) {
		if (assigned >= filled) break;
		part.value += 1;
		assigned += 1;
	}

	return {
		systemInstructions: scaled.find((part) => part.key === "systemInstructions")?.value ?? 0,
		userInput: scaled.find((part) => part.key === "userInput")?.value ?? 0,
		agentOutput: scaled.find((part) => part.key === "agentOutput")?.value ?? 0,
		tools: scaled.find((part) => part.key === "tools")?.value ?? 0,
		memory: scaled.find((part) => part.key === "memory")?.value ?? 0,
	};
}

function formatHeadline(view: ViewModel): string {
	const tokens = view.tokens;
	const contextWindow = view.contextWindow;
	const percent = view.percent;
	const approxPrefix = view.breakdown.approximate ? "~" : "";
	const tokenText = tokens === null ? "?" : `${approxPrefix}${formatTokens(tokens)}`;
	const windowText = contextWindow ? formatTokens(contextWindow) : "?";
	const pctText = percent === null ? "?%" : `${percent.toFixed(1)}%`;
	return `${tokenText}/${windowText} ${pctText} ${view.breakdown.turns}t`;
}

function colorizePercent(view: ViewModel, theme: ExtensionContext["ui"]["theme"]): string {
	const contextWindow = view.contextWindow;
	const autoIndicator = " (ctx)";
	if (!contextWindow) {
		return theme.fg("dim", `?/?${autoIndicator}`);
	}
	const raw = view.percent;
	const label = raw === null ? `?/${formatTokens(contextWindow)}${autoIndicator}` : `${raw.toFixed(1)}%/${formatTokens(contextWindow)}${autoIndicator}`;
	if (raw !== null && raw >= 90) return theme.fg("error", label);
	if (raw !== null && raw >= 70) return theme.fg("warning", label);
	return label;
}

function colorizedToken(theme: ExtensionContext["ui"]["theme"], color: string, prefix: string, value: number): string {
	return theme.fg(color as never, `${prefix}${formatTokens(value)}`);
}

function collectUsage(ctx: ExtensionContext): UsageTotals {
	const usage: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	for (const entry of ctx.sessionManager.getEntries() as SessionEntry[]) {
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
		if (entry.type === "message" && entry.message.role === "assistant") {
			count += 1;
		}
	}
	return count;
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

function readMode(value: string | undefined): Mode {
	const normalized = value?.trim().toLowerCase();
	if (normalized === "off" || normalized === "status" || normalized === "footer") {
		return normalized;
	}
	return DEFAULT_MODE as Mode;
}

function formatTokens(count: number): string {
	if (!Number.isFinite(count)) return "?";
	if (count < 1000) return `${Math.round(count)}`;
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

function formatCwd(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (home && cwd.startsWith(home)) {
		return `~${cwd.slice(home.length)}`;
	}
	return cwd;
}

function sanitizeStatusText(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}
