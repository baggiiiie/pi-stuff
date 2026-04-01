import { pathToFileURL } from "node:url";
import { execSync } from "node:child_process";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { buildRecordedSnapshots, buildLiveSnapshot, buildPayload, type Snapshot, type ChartPayload } from "./data.ts";
import { renderHtml } from "./ui.ts";

// Dynamically resolve glimpseui path from npm global modules
const npmGlobalPath = execSync("npm root -g").toString().trim();
const GLIMPSE_PATH = path.join(npmGlobalPath, "glimpseui", "src", "glimpse.mjs");
const WINDOW_TITLE = "Session Context Usage";

type GlimpseWindow = {
	on(event: "ready", handler: () => void): void;
	on(event: "closed", handler: () => void): void;
	send(js: string): void;
	close(): void;
};

export default function (pi: ExtensionAPI) {
	let recordedSnapshots: Snapshot[] = [];
	let liveSnapshot: Snapshot | null = null;
	let windowRef: GlimpseWindow | null = null;
	let windowReady = false;
	let lastPayload: ChartPayload | null = null;

	pi.registerCommand("context-chart", {
		description: "Open a live context usage chart in Glimpse",
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase();

			if (command === "close") {
				closeWindow();
				ctx.ui.notify("Context chart closed", "info");
				return;
			}

			recordedSnapshots = buildRecordedSnapshots(ctx);
			liveSnapshot = null;
			await openOrRefreshWindow(ctx);
			ctx.ui.notify("Context chart opened", "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		recordedSnapshots = buildRecordedSnapshots(ctx);
		liveSnapshot = null;
		await publish(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		recordedSnapshots = buildRecordedSnapshots(ctx);
		liveSnapshot = null;
		await publish(ctx);
	});

	pi.on("session_fork", async (_event, ctx) => {
		recordedSnapshots = buildRecordedSnapshots(ctx);
		liveSnapshot = null;
		await publish(ctx);
	});

	pi.on("session_compact", async (_event, ctx) => {
		recordedSnapshots = buildRecordedSnapshots(ctx);
		liveSnapshot = null;
		await publish(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		recordedSnapshots = buildRecordedSnapshots(ctx);
		liveSnapshot = null;
		await publish(ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		recordedSnapshots = buildRecordedSnapshots(ctx);
		liveSnapshot = null;
		await publish(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		await publish(ctx);
	});

	pi.on("context", async (event, ctx) => {
		liveSnapshot = buildLiveSnapshot(event, ctx);
		await publish(ctx);
	});

	pi.on("session_shutdown", async () => {
		closeWindow();
	});

	function closeWindow() {
		if (windowRef) {
			windowRef.close();
		}
		windowRef = null;
		windowReady = false;
	}

	async function openOrRefreshWindow(ctx: ExtensionContext) {
		if (!windowRef) {
			const { open } = await import(pathToFileURL(GLIMPSE_PATH).href);
			lastPayload = buildPayload(ctx, recordedSnapshots, liveSnapshot);
			const win = open(renderHtml(lastPayload), {
				width: 1280,
				height: 760,
				title: WINDOW_TITLE,
			});

			windowRef = win as GlimpseWindow;
			windowReady = false;

			windowRef.on("ready", () => {
				windowReady = true;
				if (lastPayload && windowRef) {
					windowRef.send(`window.updateChart(${JSON.stringify(lastPayload)})`);
				}
			});

			windowRef.on("closed", () => {
				windowRef = null;
				windowReady = false;
			});
			return;
		}

		await publish(ctx);
	}

	async function publish(ctx: ExtensionContext) {
		lastPayload = buildPayload(ctx, recordedSnapshots, liveSnapshot);
		if (!windowRef || !windowReady) return;
		windowRef.send(`window.updateChart(${JSON.stringify(lastPayload)})`);
	}
}
