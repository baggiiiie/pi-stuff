import os from "node:os";
import { CustomEditor, type ExtensionAPI, type ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { matchesKey } from "@mariozechner/pi-tui";

const KEY = "codex-usage";
const DEFAULT_PROVIDER = "openai-codex";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_REFRESH_INTERVAL_MS = 5 * 60_000;
const DEFAULT_URL = "https://chatgpt.com/backend-api/wham/usage";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

type Config = {
    provider: string;
    url: string;
    timeoutMs: number;
    refreshIntervalMs: number;
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
    updatedAt: Date;
};

type WhamWindowRaw = {
    used_percent?: unknown;
    reset_after_seconds?: unknown;
};

type WhamAdditionalRaw = {
    metered_feature?: string;
    limit_name?: string;
    rate_limit?: {
        primary_window?: WhamWindowRaw;
    };
};

type WhamRaw = {
    plan_type?: string;
    rate_limit?: {
        primary_window?: WhamWindowRaw;
        secondary_window?: WhamWindowRaw;
    };
    additional_rate_limits?: WhamAdditionalRaw[];
    credits?: {
        has_credits?: boolean;
        unlimited?: boolean;
        balance?: string;
    };
};

type RuntimeContext = Pick<ExtensionCommandContext, "ui" | "modelRegistry">;

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
    let refreshTimer: ReturnType<typeof setInterval> | undefined;
    let refreshInFlight: Promise<UsageSnapshot> | undefined;
    const config = readConfig();

    const closeUsageWidget = (ctx: Pick<ExtensionCommandContext, "ui">) => {
        ctx.ui.setWidget(KEY, undefined);
        isUsageActive = false;
    };

    const clearUsage = (ctx: Pick<ExtensionCommandContext, "ui">) => {
        closeUsageWidget(ctx);
        ctx.ui.setStatus(KEY, undefined);
    };

    const stopAutoRefresh = () => {
        if (!refreshTimer) return;
        clearInterval(refreshTimer);
        refreshTimer = undefined;
    };

    const showUsageError = (ctx: Pick<ExtensionCommandContext, "ui">, message: string, showWidget = false) => {
        if (showWidget) {
            ctx.ui.setWidget(KEY, [
                "Codex usage unavailable",
                "",
                message,
                "",
                "Run /codex-usage help for setup.",
            ]);
            isUsageActive = true;
        }
        ctx.ui.setStatus(KEY, "Codex usage unavailable");
    };

    const getUsageSnapshot = async (ctx: RuntimeContext) => {
        if (!refreshInFlight) {
            refreshInFlight = fetchUsage(config, ctx).finally(() => {
                refreshInFlight = undefined;
            });
        }
        return await refreshInFlight;
    };

    const refreshUsage = async (ctx: RuntimeContext, options?: { showWidget?: boolean; showLoading?: boolean }) => {
        if (options?.showLoading) {
            ctx.ui.setStatus(KEY, "Codex usage loading...");
        }

        try {
            const snapshot = await getUsageSnapshot(ctx);
            if (options?.showWidget || isUsageActive) {
                renderUsage(snapshot, ctx);
                if (options?.showWidget) {
                    isUsageActive = true;
                }
            } else {
                ctx.ui.setStatus(KEY, buildStatusText(snapshot));
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            showUsageError(ctx, message, Boolean(options?.showWidget || isUsageActive));
        }
    };

    const startAutoRefresh = (ctx: RuntimeContext) => {
        stopAutoRefresh();
        if (config.refreshIntervalMs <= 0) return;

        refreshTimer = setInterval(() => {
            void refreshUsage(ctx);
        }, config.refreshIntervalMs);
        refreshTimer.unref?.();
    };

    pi.registerCommand(KEY, {
        description: "Show current Codex plan usage",
        handler: async (args, ctx) => {
            const command = args.trim().toLowerCase();

            if (["clear", "off", "close", "hide"].includes(command)) {
                clearUsage(ctx);
                return;
            }

            if (command === "help") {
                showHelp(config, ctx);
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
        startAutoRefresh(ctx);
        await refreshUsage(ctx, { showLoading: true });
    });

    pi.on("session_shutdown", (_event, ctx) => {
        stopAutoRefresh();
        clearUsage(ctx);
    });
}

function showHelp(config: Config, ctx: Pick<ExtensionCommandContext, "ui">) {
    ctx.ui.setWidget(KEY, [
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
        `  CODEX_USAGE_TIMEOUT_MS=${config.timeoutMs}`,
        `  CODEX_USAGE_REFRESH_INTERVAL_MS=${config.refreshIntervalMs}`,
        "",
        "Set CODEX_USAGE_REFRESH_INTERVAL_MS=0 to disable background refresh.",
        "Endpoint must return ChatGPT WHAM-style usage JSON.",
        "",
        "The built-in default adds chatgpt-account-id, originator=pi, and a pi-style User-Agent.",
    ]);
}

async function fetchUsage(config: Config, ctx: RuntimeContext): Promise<UsageSnapshot> {
    const token = await ctx.modelRegistry.getApiKeyForProvider(config.provider);
    if (!token) {
        throw new Error(`No auth for provider "${config.provider}". Run /login and choose ChatGPT Plus/Pro (Codex).`);
    }

    const headers: Record<string, string> = {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
    };

    applyChatGPTHeaders(config, token, headers);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

    try {
        const response = await fetch(config.url, {
            method: "GET",
            headers,
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

function applyChatGPTHeaders(config: Config, token: string, headers: Record<string, string>) {
    if (!isChatGPTBackendUrl(config.url)) return;

    const accountId = extractAccountId(token);
    if (accountId) {
        headers["chatgpt-account-id"] = accountId;
    }
    headers.originator = "pi";
    headers["User-Agent"] = `pi (${os.platform()} ${os.release()}; ${os.arch()})`;
}

function looksLikeWhamUsage(raw: unknown): raw is WhamRaw {
    if (!raw || typeof raw !== "object") return false;
    const obj = raw as WhamRaw;
    return Boolean(
        obj.plan_type ||
        toFiniteNumber(obj.rate_limit?.primary_window?.used_percent) !== undefined ||
        toFiniteNumber(obj.rate_limit?.secondary_window?.used_percent) !== undefined,
    );
}

function normalizeWhamSnapshot(raw: WhamRaw): UsageSnapshot {
    const additional = raw.additional_rate_limits;
    const additionalLimits = additional
        ? additional.map(normalizeAdditionalRateLimit).filter((v): v is AdditionalRateLimit => v !== null)
        : [];

    const credits = raw.credits;
    const hasAnyCredit = credits?.has_credits !== undefined || credits?.unlimited !== undefined || credits?.balance !== undefined;

    return {
        plan: raw.plan_type,
        primary: normalizeRateWindow(raw.rate_limit?.primary_window),
        secondary: normalizeRateWindow(raw.rate_limit?.secondary_window),
        additional: additionalLimits.length > 0 ? additionalLimits : undefined,
        credits: hasAnyCredit ? { hasCredits: credits.has_credits, unlimited: credits.unlimited, balance: credits.balance } : undefined,
        updatedAt: new Date(),
    };
}

function normalizeAdditionalRateLimit(entry: WhamAdditionalRaw): AdditionalRateLimit | null {
    const primary = normalizeRateWindow(entry.rate_limit?.primary_window);
    const limitId = entry.metered_feature;
    const limitName = entry.limit_name;
    if (!primary && !limitId && !limitName) return null;
    return { limitId, limitName, primary };
}

function normalizeRateWindow(raw: WhamWindowRaw | undefined): RateWindow | undefined {
    if (!raw) return undefined;
    const usedPercent = toFiniteNumber(raw.used_percent);
    if (usedPercent === undefined) return undefined;
    return {
        usedPercent,
        resetAfterSeconds: toFiniteNumber(raw.reset_after_seconds),
    };
}

function renderUsage(snapshot: UsageSnapshot, ctx: Pick<ExtensionCommandContext, "ui">) {
    ctx.ui.setWidget(KEY, buildWhamWidgetLines(snapshot));
    ctx.ui.setStatus(KEY, buildStatusText(snapshot));
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

    lines.push(`Updated: ${snapshot.updatedAt.toLocaleString()}`);
    return lines;
}

function buildStatusText(snapshot: UsageSnapshot): string {
    if (!snapshot.primary) {
        return "Codex usage ready";
    }

    const reset = snapshot.primary.resetAfterSeconds
        ? ` | resets in ${formatRelativeSeconds(snapshot.primary.resetAfterSeconds)}`
        : "";
    return `Codex Session Limit: ${Math.round(100 - snapshot.primary.usedPercent)}% left${reset}`;
}

function formatWindow(window: RateWindow): string {
    const pct = `${Math.round(100 - window.usedPercent)}%`;
    const reset = window.resetAfterSeconds ? ` · resets in ${formatRelativeSeconds(window.resetAfterSeconds)}` : "";
    return `${pct} left${reset}`;
}

function readConfig(): Config {
    return {
        provider: process.env.CODEX_USAGE_PROVIDER?.trim() || DEFAULT_PROVIDER,
        url: process.env.CODEX_USAGE_URL?.trim() || DEFAULT_URL,
        timeoutMs: parseTimeout(process.env.CODEX_USAGE_TIMEOUT_MS),
        refreshIntervalMs: parseRefreshInterval(process.env.CODEX_USAGE_REFRESH_INTERVAL_MS),
    };
}

function parseTimeout(value: string | undefined): number {
    const parsed = Number.parseInt(value ?? "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

function parseRefreshInterval(value: string | undefined): number {
    const parsed = Number.parseInt(value ?? "", 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_REFRESH_INTERVAL_MS;
}

function toFiniteNumber(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
        const parsed = Number(value.trim());
        if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
}

function extractAccountId(token: string): string | undefined {
    try {
        const segment = token.split(".")[1];
        if (!segment) return undefined;
        const payload = JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;
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
