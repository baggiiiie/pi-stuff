import os from "node:os";
import { CustomEditor, type ExtensionAPI, type ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { matchesKey } from "@mariozechner/pi-tui";

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
    resetAfterSeconds?: number;
};

type AdditionalRateLimit = {
    limitId?: string;
    limitName?: string;
    primary?: RateWindow;
};

type UsageSnapshot = {
    plan?: string;
    primary?: RateWindow;
    secondary?: RateWindow;
    additional?: AdditionalRateLimit[];
    credits?: {
        hasCredits?: boolean;
        unlimited?: boolean;
        balance?: string;
    };
    updatedAt: string;
};

type UsageRuntimeContext = Pick<ExtensionCommandContext, "ui" | "modelRegistry">;

class CodexUsageEditor extends CustomEditor {
    private readonly isUsageActive: () => boolean;
    private readonly onDismiss: () => void;

    constructor(
        tui: ConstructorParameters<typeof CustomEditor>[0],
        theme: ConstructorParameters<typeof CustomEditor>[1],
        keybindings: ConstructorParameters<typeof CustomEditor>[2],
        isUsageActive: () => boolean,
        onDismiss: () => void,
    ) {
        super(tui, theme, keybindings);
        this.isUsageActive = isUsageActive;
        this.onDismiss = onDismiss;
    }

    override handleInput(data: string): void {
        if (matchesKey(data, "escape") && !this.isShowingAutocomplete() && this.isUsageActive()) {
            this.onDismiss();
            return;
        }
        super.handleInput(data);
    }
}

export default function (pi: ExtensionAPI) {
    let isUsageActive = false;

    const closeUsageWidget = (ctx: Pick<ExtensionCommandContext, "ui">) => {
        ctx.ui.setWidget(WIDGET_KEY, undefined);
        isUsageActive = false;
    };

    const clearUsage = (ctx: Pick<ExtensionCommandContext, "ui">) => {
        closeUsageWidget(ctx);
        ctx.ui.setStatus(STATUS_KEY, undefined);
    };

    const showUsageError = (ctx: Pick<ExtensionCommandContext, "ui">, message: string, showWidget = false) => {
        if (showWidget) {
            ctx.ui.setWidget(WIDGET_KEY, [
                "Codex usage unavailable",
                "",
                message,
                "",
                "Run /codex-usage help for setup.",
            ]);
            isUsageActive = true;
        }
        ctx.ui.setStatus(STATUS_KEY, "Codex usage unavailable");
    };

    const refreshUsage = async (ctx: UsageRuntimeContext, options?: { showWidget?: boolean; showLoading?: boolean }) => {
        if (options?.showLoading) {
            ctx.ui.setStatus(STATUS_KEY, "Codex usage loading…");
        }

        try {
            const snapshot = await fetchUsage(readConfig(), ctx);
            if (options?.showWidget || isUsageActive) {
                renderUsage(snapshot, ctx);
                if (options?.showWidget) {
                    isUsageActive = true;
                }
            } else {
                ctx.ui.setStatus(STATUS_KEY, buildStatusText(snapshot));
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            showUsageError(ctx, message, Boolean(options?.showWidget || isUsageActive));
        }
    };

    pi.registerCommand(COMMAND, {
        description: "Show current Codex plan usage",
        handler: async (args, ctx) => {
            const command = args.trim().toLowerCase();

            if (["clear", "off", "close", "hide"].includes(command)) {
                clearUsage(ctx);
                return;
            }

            if (command === "help") {
                showHelp(ctx);
                isUsageActive = true;
                return;
            }

            await refreshUsage(ctx, {
                showWidget: true,
                showLoading: true,
            });
        },
    });

    pi.on("session_start", async (_event, ctx) => {
        ctx.ui.setEditorComponent((tui, theme, keybindings) =>
            new CodexUsageEditor(tui, theme, keybindings, () => isUsageActive, () => closeUsageWidget(ctx)),
        );
        await refreshUsage(ctx, { showLoading: true });
    });

    pi.on("turn_end", async (_event, ctx) => {
        await refreshUsage(ctx, { showLoading: true });
    });

    pi.on("session_shutdown", (_event, ctx) => {
        clearUsage(ctx);
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
        "Custom endpoints must return ChatGPT WHAM-style usage JSON.",
        "",
        "The built-in default adds chatgpt-account-id, originator=pi, and a pi-style User-Agent.",
    ]);
}

async function fetchUsage(config: UsageConfig, ctx: UsageRuntimeContext): Promise<UsageSnapshot> {
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

        if (!looksLikeWhamUsage(raw)) {
            throw new Error("Usage response JSON did not include recognizable ChatGPT WHAM usage fields.");
        }

        return normalizeWhamSnapshot(raw);
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

function looksLikeWhamUsage(raw: unknown): boolean {
    return Boolean(
        pickString(raw, ["plan_type"]) ||
        pickNumber(raw, ["rate_limit.primary_window.used_percent", "rate_limit.secondary_window.used_percent"]),
    );
}

function normalizeWhamSnapshot(raw: unknown): UsageSnapshot {
    const additional = getPath(raw, "additional_rate_limits");
    const additionalLimits = Array.isArray(additional)
        ? additional.map((entry) => normalizeAdditionalRateLimit(entry)).filter(Boolean)
        : [];

    return {
        plan: pickString(raw, ["plan_type"]),
        primary: normalizeRateWindow(getPath(raw, "rate_limit.primary_window")),
        secondary: normalizeRateWindow(getPath(raw, "rate_limit.secondary_window")),
        additional: additionalLimits,
        credits: {
            hasCredits: pickBoolean(raw, ["credits.has_credits"]),
            unlimited: pickBoolean(raw, ["credits.unlimited"]),
            balance: pickString(raw, ["credits.balance"]),
        },
        updatedAt: new Date().toISOString(),
    };
}

function normalizeAdditionalRateLimit(entry: unknown): AdditionalRateLimit | null {
    const primary = normalizeRateWindow(getPath(entry, "rate_limit.primary_window"));
    const limitId = pickString(entry, ["metered_feature"]);
    const limitName = pickString(entry, ["limit_name"]);
    if (!primary && !limitId && !limitName) return null;
    return { limitId, limitName, primary };
}

function normalizeRateWindow(raw: unknown): RateWindow | undefined {
    const usedPercent = pickNumber(raw, ["used_percent"]);
    if (typeof usedPercent !== "number") return undefined;
    return {
        usedPercent,
        resetAfterSeconds: pickNumber(raw, ["reset_after_seconds"]),
    };
}

function renderUsage(snapshot: UsageSnapshot, ctx: Pick<ExtensionCommandContext, "ui">) {
    ctx.ui.setWidget(WIDGET_KEY, buildWhamWidgetLines(snapshot));
    ctx.ui.setStatus(STATUS_KEY, buildStatusText(snapshot));
}

function buildWhamWidgetLines(snapshot: UsageSnapshot): string[] {
    const lines = [
        "Codex usage",
        "",
        ...(snapshot.plan ? [`Plan: ${capitalize(snapshot.plan)}`] : []),
        ...(snapshot.primary ? [`Session:   ${formatWindow(snapshot.primary)}`] : []),
        ...(snapshot.secondary ? [`Weekly: ${formatWindow(snapshot.secondary)}`] : []),
    ];

    if (snapshot.credits) {
        const creditBits = [];
        if (typeof snapshot.credits.hasCredits === "boolean") {
            creditBits.push(snapshot.credits.hasCredits ? "credits available" : "no credits");
        }
        if (snapshot.credits.unlimited) {
            creditBits.push("unlimited");
        }
        if (snapshot.credits.balance) {
            creditBits.push(`balance ${snapshot.credits.balance}`);
        }
        if (creditBits.length > 0) {
            lines.push(`Credits: ${creditBits.join(" · ")}`);
        }
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

function buildStatusText(snapshot: UsageSnapshot): string {
    if (!snapshot.primary) {
        return "Codex usage ready";
    }

    const reset = snapshot.primary.resetAfterSeconds
        ? ` | resets in ${formatRelativeSeconds(snapshot.primary.resetAfterSeconds)}`
        : "";
    return `Codex ${Math.round(100 - snapshot.primary.usedPercent)}% left${reset}`;
}

function formatWindow(window: RateWindow): string {
    const pct = `${Math.round(100 - window.usedPercent)}%`;
    const reset = window.resetAfterSeconds ? ` · resets in ${formatRelativeSeconds(window.resetAfterSeconds)}` : "";
    return `${pct} left${reset}`;
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
        throw new Error('CODEX_USAGE_HEADERS must be valid JSON, e.g. {"x-foo":"bar"}');
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
