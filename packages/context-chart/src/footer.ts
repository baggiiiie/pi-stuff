import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { formatTokens, type FooterBreakdown, type FooterViewModel, type UsageTotals } from "./data.ts";

const FOOTER_BAR_WIDTH = 28;

type Theme = ExtensionContext["ui"]["theme"];
type FooterData = {
	getGitBranch(): string | null;
	getExtensionStatuses(): ReadonlyMap<string, string>;
	getAvailableProviderCount(): number;
};

export function buildFooterLines(
	width: number,
	theme: Theme,
	footerData: FooterData,
	ctx: ExtensionContext,
	view: FooterViewModel,
	selfKey: string,
): string[] {
	const lines: string[] = [];
	const cwd = formatCwd(ctx.cwd);
	const branch = footerData.getGitBranch();
	const sessionName = ctx.sessionManager.getSessionName();
	const leftTitle = [cwd, branch ? `(${branch})` : undefined, sessionName ? `• ${sessionName}` : undefined]
		.filter(Boolean)
		.join(" ");
	lines.push(truncateToWidth(theme.fg("dim", leftTitle), width, theme.fg("dim", "...")));

	const leftStats = buildUsageStats(view.usage, view, theme);
	const rightStats = buildModelLabel(ctx, footerData.getAvailableProviderCount(), theme);
	lines.push(joinLeftRight(leftStats, rightStats, width));

	const summaryLegend = renderLegend(view.breakdown, view.usage, theme);
	const summary = [summaryLegend].filter(Boolean).join(theme.fg("dim", " • "));
	lines.push(truncateToWidth(summary, width, theme.fg("dim", "...")));

	const barLabel = theme.fg("dim", "Context window");
	const bar =
		barLabel +
		renderBar(view, theme, Math.max(10, Math.min(FOOTER_BAR_WIDTH, width - visibleWidth(barLabel) - 1)));
	lines.push(truncateToWidth(bar, width, theme.fg("dim", "...")));

	const otherStatuses = Array.from(footerData.getExtensionStatuses().entries())
		.filter(([key]) => key !== selfKey)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, text]) => sanitizeStatusText(text));
	if (otherStatuses.length > 0) {
		lines.push(truncateToWidth(otherStatuses.join(" "), width, theme.fg("dim", "...")));
	}

	return lines;
}

function buildUsageStats(usage: UsageTotals, view: FooterViewModel, theme: Theme): string {
	const parts: string[] = [];
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(3)}`);
	parts.push(colorizePercent(view, theme));
	return theme.fg("dim", parts.join(" "));
}

function buildModelLabel(ctx: ExtensionContext, availableProviderCount: number, theme: Theme): string {
	if (!ctx.model) return theme.fg("dim", "no-model");
	const providerPrefix = availableProviderCount > 1 ? `(${ctx.model.provider}) ` : "";
	return theme.fg("dim", `${providerPrefix}${ctx.model.id}`);
}

function joinLeftRight(left: string, right: string, width: number): string {
	if (width <= 0) return "";
	// If the right side alone does not fit, truncate it and drop the left entirely.
	if (visibleWidth(right) >= width) {
		return truncateToWidth(right, width, "");
	}
	const leftWidth = visibleWidth(left);
	const rightWidth = visibleWidth(right);
	if (leftWidth + 2 + rightWidth <= width) {
		return left + " ".repeat(width - leftWidth - rightWidth) + right;
	}
	const availableLeft = Math.max(1, width - rightWidth - 1);
	const truncatedLeft = truncateToWidth(left, availableLeft, "");
	const truncatedLeftWidth = visibleWidth(truncatedLeft);
	const padding = " ".repeat(Math.max(1, width - truncatedLeftWidth - rightWidth));
	return truncatedLeft + padding + right;
}

function renderLegend(breakdown: FooterBreakdown, usage: UsageTotals, theme: Theme): string {
	const entries = [
		colorizedToken(theme, "warning", "System ", breakdown.systemInstructions),
		colorizedToken(theme, "accent", "User ", breakdown.userInput),
		colorizedToken(theme, "success", "Agent ", breakdown.agentOutput),
		colorizedToken(theme, "error", "Tools ", breakdown.tools),
		colorizedToken(theme, "muted", "Carried Context ", breakdown.memory),
		buildCacheLabel(usage, theme),
	];
	return entries.join(theme.fg("dim", " • "));
}

function buildCacheLabel(usage: UsageTotals, theme: Theme): string {
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	if (promptTokens <= 0) return theme.fg("dim", "Cache --");
	const rate = usage.cacheRead / promptTokens;
	const label = `Cache ${(rate * 100).toFixed(1)}%`;
	if (rate >= 0.7) return theme.fg("success", label);
	if (rate >= 0.3) return theme.fg("warning", label);
	return theme.fg("dim", label);
}

function renderBar(view: FooterViewModel, theme: Theme, width: number): string {
	const contextWindow = view.contextWindow;
	const total = view.tokens ?? 0;
	if (!contextWindow || contextWindow <= 0 || width <= 0) {
		return theme.fg("dim", "[no window]");
	}

	const filled = clamp(Math.round((Math.min(total, contextWindow) / contextWindow) * width), 0, width);
	const segments = allocateBarSegments(view.breakdown, filled);
	const empty = theme.fg("dim", "░".repeat(Math.max(0, width - filled)));

	return [
		theme.fg("dim", " "),
		theme.fg("warning", "█".repeat(segments.systemInstructions)),
		theme.fg("accent", "█".repeat(segments.userInput)),
		theme.fg("success", "█".repeat(segments.agentOutput)),
		theme.fg("error", "█".repeat(segments.tools)),
		theme.fg("muted", "█".repeat(segments.memory)),
		empty,
	].join("");
}

function allocateBarSegments(breakdown: FooterBreakdown, filled: number) {
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

function formatHeadline(view: FooterViewModel): string {
	const approxPrefix = view.breakdown.approximate ? "~" : "";
	const tokenText = view.tokens === null ? "?" : `${approxPrefix}${formatTokens(view.tokens)}`;
	const windowText = view.contextWindow ? formatTokens(view.contextWindow) : "?";
	const pctText = view.percent === null ? "?%" : `${view.percent.toFixed(1)}%`;
	return `${tokenText}/${windowText} ${pctText} ${view.breakdown.turns}t`;
}

function colorizePercent(view: FooterViewModel, theme: Theme): string {
	const contextWindow = view.contextWindow;
	const autoIndicator = " (ctx)";
	if (!contextWindow) return theme.fg("dim", `?/?${autoIndicator}`);
	const raw = view.percent;
	const label =
		raw === null
			? `?/${formatTokens(contextWindow)}${autoIndicator}`
			: `${raw.toFixed(1)}%/${formatTokens(contextWindow)}${autoIndicator}`;
	if (raw !== null && raw >= 90) return theme.fg("error", label);
	if (raw !== null && raw >= 70) return theme.fg("warning", label);
	return label;
}

function colorizedToken(theme: Theme, color: string, prefix: string, value: number): string {
	return theme.fg(color as never, `${prefix}${formatTokens(value)}`);
}

function formatCwd(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (home && cwd.startsWith(home)) return `~${cwd.slice(home.length)}`;
	return cwd;
}

function sanitizeStatusText(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}
