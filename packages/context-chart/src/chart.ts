import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ChartPayload } from "./data.ts";
import { renderHtml } from "./ui.ts";

const WINDOW_TITLE = "Session Context Usage";
const require = createRequire(import.meta.url);
let cachedGlimpsePath: string | null = null;

type GlimpseWindow = {
	on(event: "ready", handler: () => void): void;
	on(event: "closed", handler: () => void): void;
	send(js: string): void;
	close(): void;
};

export type ChartWindow = {
	publish(payload: ChartPayload): void;
	close(): void;
};

export async function openChartWindow(initialPayload: ChartPayload, onClosed: () => void): Promise<ChartWindow> {
	const glimpsePath = resolveGlimpsePath();
	const { open } = await import(pathToFileURL(glimpsePath).href);
	const win = open(renderHtml(initialPayload), {
		width: 1280,
		height: 760,
		title: WINDOW_TITLE,
	}) as GlimpseWindow;

	let ready = false;
	let pending: ChartPayload | null = initialPayload;

	win.on("ready", () => {
		ready = true;
		if (pending) {
			win.send(`window.updateChart(${JSON.stringify(pending)})`);
			pending = null;
		}
	});

	win.on("closed", () => {
		onClosed();
	});

	return {
		publish(payload: ChartPayload) {
			if (!ready) {
				pending = payload;
				return;
			}
			win.send(`window.updateChart(${JSON.stringify(payload)})`);
		},
		close() {
			win.close();
		},
	};
}

function run(command: string, args: string[]): string | null {
	try {
		return execFileSync(command, args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return null;
	}
}

function resolveGlimpsePath(): string {
	if (cachedGlimpsePath) return cachedGlimpsePath;

	const envPath = process.env.GLIMPSE_PATH;
	if (envPath && existsSync(envPath)) {
		cachedGlimpsePath = envPath;
		return cachedGlimpsePath;
	}

	for (const specifier of ["glimpseui", "glimpseui/src/glimpse.mjs"]) {
		try {
			const resolved = require.resolve(specifier);
			if (existsSync(resolved)) {
				cachedGlimpsePath = resolved;
				return cachedGlimpsePath;
			}
		} catch {
			// Try the next strategy.
		}
	}

	const globalNodeModulesDirs = new Set<string>();
	const npmPrefix = process.env.npm_config_prefix ?? process.env.PREFIX;
	if (npmPrefix) {
		globalNodeModulesDirs.add(path.join(npmPrefix, "node_modules"));
		globalNodeModulesDirs.add(path.join(npmPrefix, "lib", "node_modules"));
	}

	const nodePath = process.env.NODE_PATH;
	if (nodePath) {
		for (const dir of nodePath.split(path.delimiter)) {
			if (dir) globalNodeModulesDirs.add(dir);
		}
	}

	const npmRoot = run("npm", ["root", "-g"]);
	if (npmRoot) globalNodeModulesDirs.add(npmRoot);

	const pnpmRoot = run("pnpm", ["root", "-g"]);
	if (pnpmRoot) globalNodeModulesDirs.add(pnpmRoot);

	const yarnGlobalDir = run("yarn", ["global", "dir"]);
	if (yarnGlobalDir) globalNodeModulesDirs.add(path.join(yarnGlobalDir, "node_modules"));

	for (const dir of globalNodeModulesDirs) {
		const candidate = path.join(dir, "glimpseui", "src", "glimpse.mjs");
		if (existsSync(candidate)) {
			cachedGlimpsePath = candidate;
			return cachedGlimpsePath;
		}
	}

	throw new Error(
		"Could not find Glimpse. Install `glimpseui` where Node can resolve it, or set GLIMPSE_PATH to .../glimpseui/src/glimpse.mjs.",
	);
}
