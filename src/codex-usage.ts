import os from "node:os";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

const COMMAND = "codex-usage";
const WIDGET_KEY = "codex-usage";
const STATUS_KEY = "codex-usage";
const DEFAULT_PROVIDER = "openai-codex";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_URL = "https://chatgpt.com/backend-api/wham/usage";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

type UsageConfig = {
	provider: string;
	url: string;
	method: string;
	headers: Record<string, string>;
	authHeader?: string;
	authPrefix?: string;
	body?: string;
	timeoutMs: number;
};

type RateWindow = {
	usedPercent: number;
	limitWindowSeconds?: number;
	resetAfterSeconds?: number;
	resetAt?: string;
};

type AdditionalRateLimit = {
	limitId?: string;
	limitName?: string;
	primary?: RateWindow;
	secondary?: RateWindow;
};

type UsageSnapshot = {
	provider: string;
	plan?: string;
	format: "wham" | "generic";
	allowed?: boolean;
	limitReached?: boolean;
	primary?: RateWindow;
	secondary?: RateWindow;
	additional?: AdditionalRateLimit[];
	credits?: {
		hasCredits?: boolean;
		unlimited?: boolean;
		balance?: string;
	};
	used?: number;
	limit?: number;
	remaining?: number;
	unit?: string;
	resetAt?: string;
	periodStart?: string;
	periodEnd?: string;
	source: string;
	updatedAt: string;
	raw: unknown;
};

export default function (pi: ExtensionAPI) {
	let lastSnapshot: UsageSnapshot | null = null;

	pi.registerCommand(COMMAND, {
		description: "Show current Codex plan usage",
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase();

			if (["clear", "off", "close", "hide"].includes(command)) {
				clearUsageUi(ctx);
				lastSnapshot = null;
				ctx.ui.notify("Codex usage cleared", "info");
				return;
			}

			if (command === "help") {
				showHelp(ctx);
				return;
			}

			try {
				const config = readConfig();
				const snapshot = await fetchUsage(config, ctx);
				lastSnapshot = snapshot;
				renderUsage(snapshot, ctx);
				ctx.ui.notify(buildNotifyText(snapshot), "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.setWidget(WIDGET_KEY, [
					"Codex usage unavailable",
					"",
					message,
					"",
					"Run /codex-usage help for setup.",
				]);
				ctx.ui.setStatus(STATUS_KEY, "Codex usage unavailable");
				ctx.ui.notify(message, "error");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (lastSnapshot) renderUsage(lastSnapshot, ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		if (lastSnapshot) renderUsage(lastSnapshot, ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		clearUsageUi(ctx);
	});
}

function showHelp(ctx: ExtensionCommandContext) {
	const config = readConfig();
	ctx.ui.setWidget(WIDGET_KEY, [
		"/codex-usage",
		"",
		"Commands:",
		"  /codex-usage         Fetch and show usage",
		"  /codex-usage clear   Clear widget + status",
		"  /codex-usage help    Show setup help",
		"",
		"Default endpoint:",
		`  ${DEFAULT_URL}`,
		"",
		"Environment overrides:",
		`  CODEX_USAGE_URL=${config.url}`,
		`  CODEX_USAGE_PROVIDER=${config.provider}`,
		`  CODEX_USAGE_METHOD=${config.method}`,
		"  CODEX_USAGE_HEADERS=<optional JSON object>",
		"  CODEX_USAGE_AUTH_HEADER=Authorization",
		"  CODEX_USAGE_AUTH_PREFIX=Bearer",
		"  CODEX_USAGE_BODY=<optional request body>",
		"",
		"For ChatGPT Plus/Pro Codex logins, the built-in default uses:",
		"  GET https://chatgpt.com/backend-api/wham/usage",
		"",
		"It also adds chatgpt-account-id, originator=pi, and a pi-style User-Agent.",
	]);
	ctx.ui.setStatus(STATUS_KEY, "Codex usage help");
}

function clearUsageUi(ctx: Pick<ExtensionCommandContext, "ui">) {
	ctx.ui.setWidget(WIDGET_KEY, undefined);
	ctx.ui.setStatus(STATUS_KEY, undefined);
}

async function fetchUsage(config: UsageConfig, ctx: ExtensionCommandContext): Promise<UsageSnapshot> {
	const token = await ctx.modelRegistry.getApiKeyForProvider(config.provider);
	if (!token) {
		throw new Error(`No auth for provider \"${config.provider}\". Run /login and choose ChatGPT Plus/Pro (Codex).`);
	}

	const headers: Record<string, string> = {
		Accept: "application/json",
		...config.headers,
	};

	if (config.authHeader) {
		headers[config.authHeader] = config.authPrefix ? `${config.authPrefix} ${token}`.trim() : token;
	}

	applyChatGPTHeaders(config, token, headers);

	if (config.body && !headers["Content-Type"]) {
		headers["Content-Type"] = "application/json";
	}

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
	try {
		const response = await fetch(config.url, {
			method: config.method,
			headers,
			body: allowsBody(config.method) ? config.body : undefined,
			signal: controller.signal,
		});

		const text = await response.text();
		if (!response.ok) {
			throw new Error(`Usage request failed (${response.status} ${response.statusText}): ${truncate(text, 280)}`);
		}

		let raw: unknown;
		try {
			raw = text ? JSON.parse(text) : {};
		} catch {
			throw new Error(`Usage endpoint did not return JSON: ${truncate(text, 280)}`);
		}

		return normalizeSnapshot(raw, config);
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			throw new Error(`Usage request timed out after ${Math.round(config.timeoutMs / 1000)}s`);
		}
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

function applyChatGPTHeaders(config: UsageConfig, token: string, headers: Record<string, string>) {
	if (!isChatGPTBackendUrl(config.url)) return;
	const accountId = extractAccountId(token);
	if (accountId && !headers["chatgpt-account-id"]) {
		headers["chatgpt-account-id"] = accountId;
	}
	if (!headers.originator) {
		headers.originator = "pi";
	}
	if (!headers["User-Agent"]) {
		headers["User-Agent"] = `pi (${os.platform()} ${os.release()}; ${os.arch()})`;
	}
}

function normalizeSnapshot(raw: unknown, config: UsageConfig): UsageSnapshot {
	if (looksLikeWhamUsage(raw)) {
		return normalizeWhamSnapshot(raw, config);
	}
	return normalizeGenericSnapshot(raw, config);
}

function looksLikeWhamUsage(raw: unknown): boolean {
	return Boolean(
		pickString(raw, ["plan_type"]) ||
			pickNumber(raw, ["rate_limit.primary_window.used_percent", "rate_limit.secondary_window.used_percent"]),
	);
}

function normalizeWhamSnapshot(raw: unknown, config: UsageConfig): UsageSnapshot {
	const additional = getPath(raw, "additional_rate_limits");
	const additionalLimits = Array.isArray(additional)
		? additional.map((entry) => normalizeAdditionalRateLimit(entry)).filter(Boolean)
		: [];

	return {
		provider: config.provider,
		plan: pickString(raw, ["plan_type"]),
		format: "wham",
		allowed: pickBoolean(raw, ["rate_limit.allowed"]),
		limitReached: pickBoolean(raw, ["rate_limit.limit_reached"]),
		primary: normalizeRateWindow(getPath(raw, "rate_limit.primary_window")),
		secondary: normalizeRateWindow(getPath(raw, "rate_limit.secondary_window")),
		additional: additionalLimits,
		credits: {
			hasCredits: pickBoolean(raw, ["credits.has_credits"]),
			unlimited: pickBoolean(raw, ["credits.unlimited"]),
			balance: pickString(raw, ["credits.balance"]),
		},
		source: config.url,
		updatedAt: new Date().toISOString(),
		raw,
	};
}

function normalizeAdditionalRateLimit(entry: unknown): AdditionalRateLimit | null {
	const primary = normalizeRateWindow(getPath(entry, "rate_limit.primary_window"));
	const secondary = normalizeRateWindow(getPath(entry, "rate_limit.secondary_window"));
	const limitId = pickString(entry, ["metered_feature"]);
	const limitName = pickString(entry, ["limit_name"]);
	if (!primary && !secondary && !limitId && !limitName) return null;
	return { limitId, limitName, primary, secondary };
}

function normalizeRateWindow(raw: unknown): RateWindow | undefined {
	const usedPercent = pickNumber(raw, ["used_percent"]);
	if (typeof usedPercent !== "number") return undefined;
	const resetAtEpoch = pickNumber(raw, ["reset_at"]);
	return {
		usedPercent,
		limitWindowSeconds: pickNumber(raw, ["limit_window_seconds"]),
		resetAfterSeconds: pickNumber(raw, ["reset_after_seconds"]),
		resetAt: typeof resetAtEpoch === "number" ? new Date(resetAtEpoch * 1000).toISOString() : undefined,
	};
}

function normalizeGenericSnapshot(raw: unknown, config: UsageConfig): UsageSnapshot {
	const used = pickNumber(raw, [
		"used",
		"usage.used",
		"usage.current",
		"usage.amount",
		"consumed",
		"consumed.amount",
		"current_usage",
		"currentUsage",
	]);
	const limit = pickNumber(raw, [
		"limit",
		"usage.limit",
		"quota",
		"cap",
		"allowance",
		"monthly_limit",
		"monthlyLimit",
	]);
	const remaining =
		pickNumber(raw, ["remaining", "usage.remaining", "quota_remaining", "quotaRemaining"]) ??
		(typeof used === "number" && typeof limit === "number" ? Math.max(0, limit - used) : undefined);

	const plan = pickString(raw, ["plan", "plan.name", "subscription", "subscription.name", "tier", "name"]);
	const unit = pickString(raw, ["unit", "usage.unit", "quota_unit", "quotaUnit"]);
	const resetAt = pickString(raw, ["resetAt", "reset_at", "usage.resetAt", "usage.reset_at"]);
	const periodStart = pickString(raw, ["periodStart", "period_start", "usage.periodStart", "usage.period_start"]);
	const periodEnd = pickString(raw, ["periodEnd", "period_end", "usage.periodEnd", "usage.period_end"]);

	if ([used, limit, remaining, plan, resetAt, periodStart, periodEnd].every((value) => value === undefined)) {
		throw new Error(
			"Usage response JSON did not include recognizable fields. Expected wham/usage fields or generic keys like plan, used, limit, remaining, or resetAt.",
		);
	}

	return {
		provider: config.provider,
		plan,
		format: "generic",
		used,
		limit,
		remaining,
		unit,
		resetAt,
		periodStart,
		periodEnd,
		source: config.url,
		updatedAt: new Date().toISOString(),
		raw,
	};
}

function renderUsage(snapshot: UsageSnapshot, ctx: Pick<ExtensionCommandContext, "ui">) {
	const lines = snapshot.format === "wham" ? buildWhamWidgetLines(snapshot) : buildGenericWidgetLines(snapshot);
	ctx.ui.setWidget(WIDGET_KEY, lines);
	ctx.ui.setStatus(STATUS_KEY, buildStatusText(snapshot));
}

function buildWhamWidgetLines(snapshot: UsageSnapshot): string[] {
	const lines = [
		"Codex usage",
		"",
		...(snapshot.plan ? [`Plan: ${capitalize(snapshot.plan)}`] : []),
		`Provider: ${snapshot.provider}`,
		...(snapshot.primary ? [`Primary:   ${formatWindow(snapshot.primary)}`] : []),
		...(snapshot.secondary ? [`Secondary: ${formatWindow(snapshot.secondary)}`] : []),
		...(typeof snapshot.allowed === "boolean" ? [`Allowed: ${snapshot.allowed ? "yes" : "no"}`] : []),
		...(typeof snapshot.limitReached === "boolean"
			? [`Limit hit: ${snapshot.limitReached ? "yes" : "no"}`]
			: []),
	];

	if (snapshot.credits) {
		const creditBits = [];
		if (typeof snapshot.credits.hasCredits === "boolean") {
			creditBits.push(snapshot.credits.hasCredits ? "credits available" : "no credits");
		}
		if (typeof snapshot.credits.unlimited === "boolean" && snapshot.credits.unlimited) {
			creditBits.push("unlimited");
		}
		if (snapshot.credits.balance) {
			creditBits.push(`balance ${snapshot.credits.balance}`);
		}
		if (creditBits.length > 0) lines.push(`Credits: ${creditBits.join(" · ")}`);
	}

	if (snapshot.additional && snapshot.additional.length > 0) {
		lines.push("", "Additional limits:");
		for (const item of snapshot.additional.slice(0, 4)) {
			const label = item.limitName || item.limitId || "other";
			const primary = item.primary ? formatWindow(item.primary) : "no primary window";
			lines.push(`- ${label}: ${primary}`);
		}
	}

	lines.push(`Updated: ${formatDate(snapshot.updatedAt)}`);
	return lines;
}

function buildGenericWidgetLines(snapshot: UsageSnapshot): string[] {
	return [
		"Codex usage",
		"",
		...(snapshot.plan ? [`Plan: ${snapshot.plan}`] : []),
		`Provider: ${snapshot.provider}`,
		...buildGenericUsageLines(snapshot),
		...(snapshot.resetAt ? [`Resets: ${formatDate(snapshot.resetAt)}`] : []),
		...(snapshot.periodStart || snapshot.periodEnd
			? [`Period: ${formatPeriod(snapshot.periodStart, snapshot.periodEnd)}`]
			: []),
		`Updated: ${formatDate(snapshot.updatedAt)}`,
	];
}

function buildGenericUsageLines(snapshot: UsageSnapshot): string[] {
	const unit = snapshot.unit ? ` ${snapshot.unit}` : "";
	if (typeof snapshot.used === "number" && typeof snapshot.limit === "number") {
		const pct = snapshot.limit > 0 ? Math.round((snapshot.used / snapshot.limit) * 100) : 0;
		const bar = renderBar(snapshot.used, snapshot.limit);
		const lines = [`Usage: ${snapshot.used}/${snapshot.limit}${unit} (${pct}%)`, `Bar:   ${bar}`];
		if (typeof snapshot.remaining === "number") lines.push(`Left:  ${snapshot.remaining}${unit}`);
		return lines;
	}
	if (typeof snapshot.used === "number") return [`Used: ${snapshot.used}${unit}`];
	if (typeof snapshot.remaining === "number") return [`Remaining: ${snapshot.remaining}${unit}`];
	return ["Usage values were partially missing from the response."];
}

function buildNotifyText(snapshot: UsageSnapshot): string {
	if (snapshot.format === "wham" && snapshot.primary) {
		return `Codex usage: ${Math.round(snapshot.primary.usedPercent)}% of ${formatDuration(snapshot.primary.limitWindowSeconds)}`;
	}
	if (typeof snapshot.used === "number" && typeof snapshot.limit === "number" && snapshot.limit > 0) {
		const pct = Math.round((snapshot.used / snapshot.limit) * 100);
		return `Codex usage: ${pct}% used`;
	}
	if (typeof snapshot.used === "number") return `Codex used: ${snapshot.used}`;
	return "Codex usage updated";
}

function buildStatusText(snapshot: UsageSnapshot): string {
	if (snapshot.format === "wham" && snapshot.primary) {
		const reset = snapshot.primary.resetAfterSeconds ? ` · ${formatRelativeSeconds(snapshot.primary.resetAfterSeconds)} left` : "";
		return `Codex ${Math.round(snapshot.primary.usedPercent)}%${reset}`;
	}
	if (typeof snapshot.used === "number" && typeof snapshot.limit === "number" && snapshot.limit > 0) {
		const pct = Math.round((snapshot.used / snapshot.limit) * 100);
		const remaining = typeof snapshot.remaining === "number" ? ` · ${snapshot.remaining} left` : "";
		return `Codex ${pct}%${remaining}`;
	}
	if (typeof snapshot.used === "number") return `Codex used ${snapshot.used}`;
	return "Codex usage ready";
}

function renderBar(used: number, limit: number, width = 16): string {
	if (limit <= 0) return "[unknown]";
	const ratio = Math.min(1, Math.max(0, used / limit));
	const filled = Math.round(width * ratio);
	return `[${"█".repeat(filled)}${"░".repeat(Math.max(0, width - filled))}]`;
}

function formatWindow(window: RateWindow): string {
	const pct = `${Math.round(window.usedPercent)}%`;
	const duration = formatDuration(window.limitWindowSeconds);
	const reset = window.resetAfterSeconds ? ` · resets in ${formatRelativeSeconds(window.resetAfterSeconds)}` : "";
	return `${pct} of ${duration}${reset}`;
}

function readConfig(): UsageConfig {
	return {
		provider: process.env.CODEX_USAGE_PROVIDER?.trim() || DEFAULT_PROVIDER,
		url: process.env.CODEX_USAGE_URL?.trim() || DEFAULT_URL,
		method: process.env.CODEX_USAGE_METHOD?.trim().toUpperCase() || "GET",
		headers: parseHeaders(process.env.CODEX_USAGE_HEADERS),
		authHeader: process.env.CODEX_USAGE_AUTH_HEADER?.trim() || "Authorization",
		authPrefix: process.env.CODEX_USAGE_AUTH_PREFIX?.trim() || "Bearer",
		body: process.env.CODEX_USAGE_BODY,
		timeoutMs: parseTimeout(process.env.CODEX_USAGE_TIMEOUT_MS),
	};
}

function parseHeaders(value: string | undefined): Record<string, string> {
	if (!value?.trim()) return {};
	try {
		const parsed = JSON.parse(value) as Record<string, unknown>;
		return Object.fromEntries(
			Object.entries(parsed)
				.filter((entry): entry is [string, string] => typeof entry[1] === "string")
				.map(([key, headerValue]) => [key, headerValue]),
		);
	} catch {
		throw new Error("CODEX_USAGE_HEADERS must be valid JSON, e.g. {\"x-foo\":\"bar\"}");
	}
}

function parseTimeout(value: string | undefined): number {
	const parsed = Number.parseInt(value ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

function allowsBody(method: string): boolean {
	return !["GET", "HEAD"].includes(method.toUpperCase());
}

function pickNumber(input: unknown, paths: string[]): number | undefined {
	for (const path of paths) {
		const value = getPath(input, path);
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value === "string" && value.trim()) {
			const parsed = Number(value.trim());
			if (Number.isFinite(parsed)) return parsed;
		}
	}
	return undefined;
}

function pickString(input: unknown, paths: string[]): string | undefined {
	for (const path of paths) {
		const value = getPath(input, path);
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

function pickBoolean(input: unknown, paths: string[]): boolean | undefined {
	for (const path of paths) {
		const value = getPath(input, path);
		if (typeof value === "boolean") return value;
	}
	return undefined;
}

function getPath(input: unknown, path: string): unknown {
	const parts = path.split(".");
	let current: unknown = input;
	for (const part of parts) {
		if (!current || typeof current !== "object" || !(part in current)) return undefined;
		current = (current as Record<string, unknown>)[part];
	}
	return current;
}

function extractAccountId(token: string): string | undefined {
	try {
		const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
		const auth = payload[JWT_CLAIM_PATH] as Record<string, unknown> | undefined;
		const accountId = auth?.chatgpt_account_id;
		return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
	} catch {
		return undefined;
	}
}

function isChatGPTBackendUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return parsed.hostname === "chatgpt.com" && parsed.pathname.startsWith("/backend-api/");
	} catch {
		return false;
	}
}

function formatDate(value: string): string {
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp)) return value;
	return new Date(timestamp).toLocaleString();
}

function formatPeriod(start?: string, end?: string): string {
	if (start && end) return `${formatDate(start)} → ${formatDate(end)}`;
	if (start) return `from ${formatDate(start)}`;
	if (end) return `until ${formatDate(end)}`;
	return "—";
}

function formatDuration(seconds?: number): string {
	if (!seconds || seconds <= 0) return "unknown window";
	const units = [
		[7 * 24 * 60 * 60, "w"],
		[24 * 60 * 60, "d"],
		[60 * 60, "h"],
		[60, "m"],
	] as const;
	for (const [unitSeconds, label] of units) {
		if (seconds % unitSeconds === 0) return `${seconds / unitSeconds}${label}`;
	}
	if (seconds >= 60 * 60) return `${Math.round(seconds / 3600)}h`;
	if (seconds >= 60) return `${Math.round(seconds / 60)}m`;
	return `${seconds}s`;
}

function formatRelativeSeconds(seconds: number): string {
	if (seconds <= 0) return "now";
	const days = Math.floor(seconds / 86400);
	const hours = Math.floor((seconds % 86400) / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const parts: string[] = [];
	if (days) parts.push(`${days}d`);
	if (hours) parts.push(`${hours}h`);
	if (minutes && parts.length < 2) parts.push(`${minutes}m`);
	if (parts.length === 0) parts.push(`${seconds}s`);
	return parts.slice(0, 2).join(" ");
}

function capitalize(value: string): string {
	return value.length > 0 ? value[0].toUpperCase() + value.slice(1) : value;
}

function truncate(value: string, maxLength: number): string {
	const compact = value.replace(/\s+/g, " ").trim();
	return compact.length > maxLength ? `${compact.slice(0, maxLength)}…` : compact;
}
