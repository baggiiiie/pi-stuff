import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";

const KEY = "rtk-rewrite";
const DEFAULT_TIMEOUT_MS = 2000;
const MAX_CACHE_ENTRIES = 200;
const LC_ALL_PREFIX = "export LC_ALL=C";

type Config = {
	enabledByDefault: boolean;
	timeoutMs: number;
	verbose: boolean;
	showStatus: boolean;
};

export default function rtkRewriteExtension(pi: ExtensionAPI) {
	const config = readConfig();
	const rewriteCache = new Map<string, string | null>();
	let sessionEnabled = config.enabledByDefault;
	let rtkAvailable: boolean | null = null;

	pi.registerCommand(KEY, {
		description: "Manage RTK bash rewriting: /rtk-rewrite [status|on|off|refresh|test <cmd>|help]",
		handler: async (args, ctx) => {
			const trimmed = (args ?? "").trim();
			const [command, ...rest] = trimmed.split(/\s+/).filter(Boolean);
			const subcommand = command?.toLowerCase() ?? "status";

			switch (subcommand) {
				case "":
				case "status": {
					await refreshAvailability(ctx, true);
					ctx.ui.notify(buildStatusMessage(config, sessionEnabled, rtkAvailable), "info");
					return;
				}
				case "on": {
					sessionEnabled = true;
					await refreshAvailability(ctx, true);
					updateStatus(ctx);
					ctx.ui.notify(buildStatusMessage(config, sessionEnabled, rtkAvailable), "info");
					return;
				}
				case "off": {
					sessionEnabled = false;
					updateStatus(ctx);
					ctx.ui.notify(buildStatusMessage(config, sessionEnabled, rtkAvailable), "info");
					return;
				}
				case "refresh": {
					rewriteCache.clear();
					await refreshAvailability(ctx, true);
					updateStatus(ctx);
					ctx.ui.notify(buildStatusMessage(config, sessionEnabled, rtkAvailable), "info");
					return;
				}
				case "test": {
					const rawCommand = rest.join(" ").trim();
					if (!rawCommand) {
						ctx.ui.notify("Usage: /rtk-rewrite test <bash command>", "warning");
						return;
					}
					await refreshAvailability(ctx, true);
					if (!rtkAvailable) {
						ctx.ui.notify("RTK is not available. Install RTK and ensure `rtk rewrite` works in PATH.", "warning");
						return;
					}
					const rewritten = await getRewrite(rawCommand, ctx);
					if (rewritten) {
						ctx.ui.notify(`RTK rewrite\n\n${rawCommand}\n→\n${rewritten}`, "info");
					} else {
						ctx.ui.notify(`No RTK rewrite available for:\n\n${rawCommand}`, "info");
					}
					return;
				}
				case "help": {
					ctx.ui.notify(
						[
							"/rtk-rewrite",
							"",
							"Commands:",
							"  /rtk-rewrite status        Show current state",
							"  /rtk-rewrite on            Enable rewriting for this session",
							"  /rtk-rewrite off           Disable rewriting for this session",
							"  /rtk-rewrite refresh       Re-check RTK availability",
							"  /rtk-rewrite test <cmd>    Preview one rewrite",
							"",
							"Environment:",
							`  PI_RTK_REWRITE_ENABLED=${config.enabledByDefault ? "1" : "0"}`,
							`  PI_RTK_REWRITE_TIMEOUT_MS=${config.timeoutMs}`,
							`  PI_RTK_REWRITE_VERBOSE=${config.verbose ? "1" : "0"}`,
							`  PI_RTK_REWRITE_SHOW_STATUS=${config.showStatus ? "1" : "0"}`,
							"",
							"Notes:",
							"  - Rewrites only pi bash tool calls.",
							"  - pi read/edit/write tools do not go through RTK.",
						].join("\n"),
						"info",
					);
					return;
				}
				default: {
					ctx.ui.notify("Unknown subcommand. Try /rtk-rewrite help", "warning");
					return;
				}
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		sessionEnabled = config.enabledByDefault;
		rewriteCache.clear();
		await refreshAvailability(ctx, false);
		updateStatus(ctx);
		if (rtkAvailable === false && ctx.hasUI) {
			ctx.ui.notify("RTK rewrite extension loaded, but `rtk rewrite` is not available from PATH.", "warning");
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus(KEY, undefined);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!sessionEnabled) return;
		if (!isToolCallEventType("bash", event)) return;

		const original = event.input.command;
		if (typeof original !== "string" || !original.trim()) return;
		if (original.trimStart().startsWith("rtk ")) return;

		await refreshAvailability(ctx, false);
		if (!rtkAvailable) return;

		const rewritten = await getRewrite(original, ctx);
		if (!rewritten || rewritten === original) return;

		event.input.command = withLcAll(rewritten);
		if (config.verbose && ctx.hasUI) {
			ctx.ui.notify(`RTK rewrite: ${original} → ${rewritten}`, "info");
		}
	});

	async function refreshAvailability(ctx: ExtensionContext, force: boolean): Promise<boolean> {
		if (!force && rtkAvailable !== null) return rtkAvailable;

		try {
			const result = await pi.exec("rtk", ["rewrite", "git status"], {
				timeout: config.timeoutMs,
				signal: ctx.signal,
			});
			const stdout = result.stdout.trim();
			const ok = stdout.length > 0 && stdout.startsWith("rtk ");
			rtkAvailable = ok;
			return ok;
		} catch {
			rtkAvailable = false;
			return false;
		}
	}

	async function getRewrite(command: string, ctx: ExtensionContext): Promise<string | null> {
		if (rewriteCache.has(command)) {
			return rewriteCache.get(command) ?? null;
		}

		let rewritten: string | null = null;
		try {
			const result = await pi.exec("rtk", ["rewrite", command], {
				timeout: config.timeoutMs,
				signal: ctx.signal,
			});
			const stdout = result.stdout.trim();
			rewritten = stdout && stdout !== command ? stdout : null;
		} catch {
			// Leave as null; do not block the original bash command.
		}

		rememberRewrite(command, rewritten);
		return rewritten;
	}

	function rememberRewrite(command: string, rewritten: string | null) {
		rewriteCache.set(command, rewritten);
		if (rewriteCache.size <= MAX_CACHE_ENTRIES) return;
		const oldestKey = rewriteCache.keys().next().value;
		if (oldestKey !== undefined) {
			rewriteCache.delete(oldestKey);
		}
	}

	function updateStatus(ctx: Pick<ExtensionContext, "ui">) {
		if (!config.showStatus) {
			ctx.ui.setStatus(KEY, undefined);
			return;
		}
		ctx.ui.setStatus(KEY, buildStatusLine(sessionEnabled, rtkAvailable));
	}
}

function withLcAll(command: string): string {
	if (command.includes("LC_ALL=")) return command;
	return `${LC_ALL_PREFIX}\n${command}`;
}

function buildStatusMessage(config: Config, sessionEnabled: boolean, rtkAvailable: boolean | null): string {
	const availability = rtkAvailable === null ? "checking" : rtkAvailable ? "available" : "missing";
	return [
		`RTK rewrite: ${sessionEnabled ? "enabled" : "disabled"}`,
		`RTK binary: ${availability}`,
		`Timeout: ${config.timeoutMs}ms`,
		`Verbose: ${config.verbose ? "on" : "off"}`,
	].join("\n");
}

function buildStatusLine(sessionEnabled: boolean, rtkAvailable: boolean | null): string {
	if (!sessionEnabled) return "RTK: off";
	if (rtkAvailable === null) return "RTK: checking";
	return rtkAvailable ? "RTK: on" : "RTK: missing";
}

function readConfig(): Config {
	return {
		enabledByDefault: readBooleanEnv("PI_RTK_REWRITE_ENABLED", true),
		timeoutMs: readPositiveIntEnv("PI_RTK_REWRITE_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
		verbose: readBooleanEnv("PI_RTK_REWRITE_VERBOSE", false),
		showStatus: readBooleanEnv("PI_RTK_REWRITE_SHOW_STATUS", true),
	};
}

function readBooleanEnv(name: string, fallback: boolean): boolean {
	const raw = process.env[name]?.trim().toLowerCase();
	if (!raw) return fallback;
	if (["1", "true", "yes", "on"].includes(raw)) return true;
	if (["0", "false", "no", "off"].includes(raw)) return false;
	return fallback;
}

function readPositiveIntEnv(name: string, fallback: number): number {
	const raw = process.env[name]?.trim();
	if (!raw) return fallback;
	const value = Number.parseInt(raw, 10);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}
