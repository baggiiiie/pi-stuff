import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { openChartWindow, type ChartWindow } from "./chart.ts";
import {
	buildChartPayload,
	buildFooterViewModel,
	computeSharedState,
	type SharedState,
} from "./data.ts";
import { buildFooterLines } from "./footer.ts";

const KEY = "context-chart";

export default function (pi: ExtensionAPI) {
	let state: SharedState | null = null;
	let footerEnabled = readFooterDefault(process.env.PI_CONTEXT_CHART_FOOTER);
	let footerRegistered = false;
	let chartWindow: ChartWindow | null = null;
	let tuiRef: { requestRender(): void } | null = null;

	function ensureState(ctx: ExtensionContext, event?: ContextEvent): SharedState {
		if (!state) state = computeSharedState(ctx, event);
		return state;
	}

	function refresh(ctx: ExtensionContext, event?: ContextEvent) {
		state = computeSharedState(ctx, event);
		if (chartWindow) chartWindow.publish(buildChartPayload(state, ctx));
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
		const s = ensureState(ctx);
		const payload = buildChartPayload(s, ctx);
		if (chartWindow) {
			chartWindow.publish(payload);
			return;
		}
		chartWindow = await openChartWindow(payload, () => {
			chartWindow = null;
		});
	}

	function closeChart() {
		if (chartWindow) {
			chartWindow.close();
			chartWindow = null;
		}
	}

	pi.registerCommand(KEY, {
		description: "Open a live context usage chart in Glimpse and/or toggle the context footer",
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase();

			switch (command) {
				case "": {
					try {
						await openChart(ctx);
						ctx.ui.notify("Context chart opened", "info");
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						ctx.ui.notify(`Failed to open context chart: ${message}`, "info");
					}
					return;
				}
				case "close":
					if (chartWindow) {
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

	function showHelp(ctx: ExtensionContext) {
		ctx.ui.setWidget(KEY, [
			"/context-chart",
			"",
			"Commands:",
			"  /context-chart           Open the live context usage chart",
			"  /context-chart close     Close the chart window",
			"  /context-chart footer    Toggle the context footer on/off",
			"  /context-chart refresh   Recompute context state (updates chart + footer)",
			"  /context-chart help      Show this help widget",
			"  /context-chart clear     Hide this help widget",
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

	pi.on("session_start", handleSessionUpdate);
	pi.on("session_switch", handleSessionUpdate);
	pi.on("session_fork", handleSessionUpdate);
	pi.on("session_compact", handleSessionUpdate);
	pi.on("session_tree", handleSessionUpdate);
	pi.on("turn_end", handleSessionUpdate);
	pi.on("model_select", handleSessionUpdate);

	pi.on("context", (event: ContextEvent, ctx) => {
		refresh(ctx, event);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		state = null;
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
