import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ContextEvent, ExtensionAPI, ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import { openChartWindow, type ChartWindow } from "./chart.ts";
import {
	buildChartPayload,
	buildFooterViewModel,
	computeSharedState,
	formatTokens,
	type ContextInspection,
	type SharedState,
	type ToolDef,
} from "./data.ts";
import { buildFooterLines } from "./footer.ts";

const KEY = "context-chart";

export default function (pi: ExtensionAPI) {
	let state: SharedState | null = null;
	let lastRequestContext: ContextInspection | undefined;
	let footerEnabled = readFooterDefault(process.env.PI_CONTEXT_CHART_FOOTER);
	let footerRegistered = false;
	let chartWindow: ChartWindow | null = null;
	let chartOpening: Promise<void> | null = null;
	let chartGeneration = 0;
	let tuiRef: { requestRender(): void } | null = null;

	function getToolDefs(): ToolDef[] {
		try {
			const active = new Set(pi.getActiveTools());
			return pi
				.getAllTools()
				.filter((tool) => active.has(tool.name))
				.map((tool) => ({
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters,
					source: tool.sourceInfo?.scope,
				}));
		} catch {
			return [];
		}
	}

	function ensureState(ctx: ExtensionContext): SharedState {
		if (!state) state = computeSharedState(ctx, undefined, getToolDefs());
		return state;
	}

	function refresh(ctx: ExtensionContext, event?: ContextEvent) {
		state = computeSharedState(ctx, event, getToolDefs());
		if (event) lastRequestContext = state.context;
		if (chartWindow) chartWindow.publish(buildChartPayload(state, ctx, lastRequestContext));
		if (footerRegistered && tuiRef) tuiRef.requestRender();
	}

	function registerFooter(ctx: ExtensionContext) {
		if (footerRegistered) return;
		footerRegistered = true;
		ctx.ui.setFooter((tui, theme, footerData) => {
			tuiRef = tui;
			const unsub = footerData.onBranchChange(() => tui.requestRender());
			return {
				dispose: () => {
					unsub();
					tuiRef = null;
				},
				invalidate() {},
				render(width: number): string[] {
					const s = ensureState(ctx);
					return buildFooterLines(width, theme, footerData, ctx, buildFooterViewModel(s), KEY);
				},
			};
		});
	}

	function unregisterFooter(ctx: ExtensionContext) {
		if (!footerRegistered) return;
		footerRegistered = false;
		ctx.ui.setFooter(undefined);
		tuiRef = null;
	}

	async function openChart(ctx: ExtensionContext) {
		if (chartOpening) return chartOpening;
		const payload = buildChartPayload(ensureState(ctx), ctx, lastRequestContext);
		if (chartWindow) {
			chartWindow.publish(payload);
			return;
		}
		const generation = ++chartGeneration;
		chartOpening = (async () => {
			const win = await openChartWindow(payload, () => {
				if (generation === chartGeneration) {
					chartGeneration++;
					chartWindow = null;
				}
			});
			// Close a window that finished opening after close or shutdown.
			if (generation !== chartGeneration) {
				win.close();
				return;
			}
			chartWindow = win;
			win.publish(buildChartPayload(ensureState(ctx), ctx, lastRequestContext));
		})().finally(() => { chartOpening = null; });
		return chartOpening;
	}

	function closeChart() {
		chartGeneration++;
		const win = chartWindow;
		chartWindow = null;
		win?.close();
	}

	pi.registerCommand(KEY, {
		description: "Open a live context chart and inspector in Glimpse or your browser, or toggle the footer",
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase();

			switch (command) {
				case "": {
					try {
						await openChart(ctx);
						if (chartWindow) {
							const message = chartWindow.url ? `Context chart opened in browser: ${chartWindow.url}` : "Context chart opened";
							ctx.ui.notify(message, "info");
						}
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						ctx.ui.notify(`Failed to open context chart: ${message}`, "info");
					}
					return;
				}
				case "close":
					if (chartWindow || chartOpening) {
						closeChart();
						ctx.ui.notify("Context chart closed", "info");
					} else {
						ctx.ui.notify("Context chart is not open", "info");
					}
					return;
				case "footer":
					footerEnabled = !footerEnabled;
					if (footerEnabled) {
						registerFooter(ctx);
						ctx.ui.notify("Context footer enabled", "info");
					} else {
						unregisterFooter(ctx);
						ctx.ui.notify("Context footer disabled", "info");
					}
					return;
				case "refresh":
					refresh(ctx);
					ctx.ui.notify("Context refreshed", "info");
					return;
				case "prompt-cache":
					showPromptCache(ctx);
					return;
				case "help":
					showHelp(ctx);
					return;
				case "clear":
					ctx.ui.setWidget(KEY, undefined);
					return;
				default:
					ctx.ui.notify(`Unknown subcommand: ${args.trim()}. Try /context-chart help`, "info");
			}
		},
	});

	function showPromptCache(ctx: ExtensionContext) {
		const view = buildPromptCacheViewModel(ctx);
		ctx.ui.setWidget(KEY, buildPromptCacheWidgetLines(view));
	}

	function showHelp(ctx: ExtensionContext) {
		ctx.ui.setWidget(KEY, [
			"/context-chart",
			"",
			"Commands:",
			"  /context-chart              Open the live context usage chart",
			"  /context-chart close        Close the chart window",
			"  /context-chart footer       Toggle the context footer on/off",
			"  /context-chart prompt-cache  Show prompt cache hit rate stats",
			"  /context-chart refresh      Recompute context state (updates chart + footer)",
			"  /context-chart help         Show this help widget",
			"  /context-chart clear        Hide this help widget",
			"",
			`Footer: ${footerEnabled ? "on" : "off"}`,
			`Chart:  ${chartWindow ? "open" : "closed"}`,
			`Startup footer env: PI_CONTEXT_CHART_FOOTER=${process.env.PI_CONTEXT_CHART_FOOTER ?? "on"}`,
		]);
	}

	const handleSessionUpdate = (_event: unknown, ctx: ExtensionContext) => {
		if (footerEnabled) registerFooter(ctx);
		refresh(ctx);
	};

	const handleContextReset = (event: unknown, ctx: ExtensionContext) => {
		lastRequestContext = undefined;
		handleSessionUpdate(event, ctx);
	};
	pi.on("session_start", handleContextReset);
	pi.on("session_compact", handleContextReset);
	pi.on("session_tree", handleContextReset);
	pi.on("turn_end", handleSessionUpdate);
	pi.on("model_select", handleSessionUpdate);

	pi.on("context", (event: ContextEvent, ctx) => {
		refresh(ctx, event);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		state = null;
		lastRequestContext = undefined;
		closeChart();
		unregisterFooter(ctx);
		ctx.ui.setWidget(KEY, undefined);
	});
}

function readFooterDefault(value: string | undefined): boolean {
	const normalized = value?.trim().toLowerCase();
	if (normalized === "off" || normalized === "false" || normalized === "0") return false;
	return true;
}

type CacheUsageTotals = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
};

type PromptCacheViewModel = {
	total: CacheUsageTotals;
	last?: CacheUsageTotals;
};

function buildPromptCacheViewModel(ctx: ExtensionContext): PromptCacheViewModel {
	const total: CacheUsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
	let last: CacheUsageTotals | undefined;

	for (const entry of ctx.sessionManager.getBranch() as SessionEntry[]) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const message = entry.message as AssistantMessage;
		const usage: CacheUsageTotals = {
			input: message.usage?.input ?? 0,
			output: message.usage?.output ?? 0,
			cacheRead: message.usage?.cacheRead ?? 0,
			cacheWrite: message.usage?.cacheWrite ?? 0,
			cost: message.usage?.cost?.total ?? 0,
			turns: 1,
		};
		total.input += usage.input;
		total.output += usage.output;
		total.cacheRead += usage.cacheRead;
		total.cacheWrite += usage.cacheWrite;
		total.cost += usage.cost;
		total.turns += 1;
		last = usage;
	}

	return { total, last };
}

function buildPromptCacheWidgetLines(view: PromptCacheViewModel): string[] {
	return [
		"Prompt cache hit rate",
		"",
		...formatCacheUsageBlock("Session", view.total),
		"",
		...(view.last ? formatCacheUsageBlock("Last assistant turn", view.last) : ["Last assistant turn: none"]),
		"",
		"Formula: cacheRead / (input + cacheRead + cacheWrite)",
	];
}

function formatCacheUsageBlock(label: string, usage: CacheUsageTotals): string[] {
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	const rate = promptTokens > 0 ? usage.cacheRead / promptTokens : null;
	return [
		`${label}: ${rate === null ? "no cache token data" : `${(rate * 100).toFixed(1)}%`}`,
		`  input:       ${formatTokens(usage.input)}`,
		`  cache read:  ${formatTokens(usage.cacheRead)}`,
		`  cache write: ${formatTokens(usage.cacheWrite)}`,
		`  output:      ${formatTokens(usage.output)}`,
		`  turns:       ${usage.turns}`,
		`  cost:        $${usage.cost.toFixed(4)}`,
	];
}
