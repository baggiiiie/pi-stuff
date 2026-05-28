import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type LazyExtension = {
	command: string;
	description?: string;
	path: string;
};

type RawLazyExtension =
	| LazyExtension
	| {
			path?: string;
			commands?: Record<string, string>;
			package?: string;
		};

const AGENT_DIR = resolve(homedir(), ".pi/agent");
const MANIFEST_PATH = resolve(AGENT_DIR, "lazy-extensions.json");
const SETTINGS_PATH = resolve(AGENT_DIR, "settings.json");

export default function lazyLoadExtension(pi: ExtensionAPI) {
	const loaded = new Set<string>();
	const lazyExtensions = loadLazyExtensions();

	pi.registerCommand("lazy:list", {
		description: "List configured lazy extensions",
		handler: async (_args, ctx) => {
			if (lazyExtensions.length === 0) {
				ctx.ui.notify("No lazy extensions configured", "info");
				return;
			}

			ctx.ui.notify(
				lazyExtensions
					.map((ext) => {
						const state = loaded.has(ext.command) ? "loaded" : "not loaded";
						return `/${ext.command} — ${ext.description ?? ext.path} (${state})`;
					})
					.join("\n"),
				"info",
			);
		},
	});

	for (const ext of lazyExtensions) {
		pi.registerCommand(ext.command, {
			description: ext.description ?? `Load lazy extension ${ext.command}`,
			handler: async (_args, ctx) => {
				if (loaded.has(ext.command)) {
					ctx.ui.notify(`${ext.command} is already loaded`, "info");
					return;
				}

				const fullPath = resolveLazyPath(ext.path);
				if (!existsSync(fullPath)) {
					ctx.ui.notify(`Lazy extension not found: ${fullPath}`, "error");
					return;
				}

				try {
					const mod = await import(pathToFileURL(fullPath).href);
					const install = mod.install ?? mod.default;

					if (typeof install !== "function") {
						ctx.ui.notify(
							`Lazy extension ${ext.command} must export default(pi) or install(pi)`,
							"error",
						);
						return;
					}

					await install(pi);
					loaded.add(ext.command);
					ctx.ui.notify(`${ext.command} loaded`, "info");
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Failed to load ${ext.command}: ${message}`, "error");
				}
			},
		});
	}
}

function loadLazyExtensions(): LazyExtension[] {
	const byCommand = new Map<string, LazyExtension>();

	for (const ext of [...readLazyFile(MANIFEST_PATH), ...readLazyFile(SETTINGS_PATH)].flatMap(normalize)) {
		byCommand.set(ext.command, ext);
	}

	return [...byCommand.values()];
}

function readLazyFile(path: string): RawLazyExtension[] {
	if (!existsSync(path)) return [];

	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		if (Array.isArray(parsed)) return parsed;
		if (Array.isArray(parsed.lazyExtensions)) return parsed.lazyExtensions;
	} catch {
		return [];
	}

	return [];
}

function normalize(raw: RawLazyExtension): LazyExtension[] {
	if ("command" in raw && raw.command && raw.path) return [raw];

	if ("commands" in raw && raw.commands && raw.path) {
		return Object.entries(raw.commands).map(([command, description]) => ({
			command,
			description,
			path: raw.path!,
		}));
	}

	return [];
}

function resolveLazyPath(path: string): string {
	const expanded = path === "~" || path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
	return isAbsolute(expanded) ? expanded : resolve(AGENT_DIR, expanded);
}
