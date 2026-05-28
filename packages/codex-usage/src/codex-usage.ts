import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CustomEditor, type ExtensionAPI, type ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { matchesKey } from "@mariozechner/pi-tui";

const KEY = "codex-usage";
const DEFAULT_PROVIDER = "openai-codex";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_REFRESH_INTERVAL_MS = 5 * 60_000;
const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_URL = "https://chatgpt.com/backend-api/wham/usage";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const LOCK_STALE_AFTER_MS = 30_000;
const LOCK_WAIT_POLL_MS = 250;

type Config = {
    provider: string;
    url: string;
    timeoutMs: number;
    refreshIntervalMs: number;
    cacheTtlMs: number;
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

type SerializedUsageSnapshot = Omit<UsageSnapshot, "updatedAt"> & {
    updatedAt: string;
};

type SharedCachePaths = {
    dir: string;
    cachePath: string;
    lockPath: string;
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

type StatusContext = Pick<ExtensionCommandContext, "ui">;

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

    const closeUsageWidget = (ctx: StatusContext) => {
        ctx.ui.setWidget(KEY, undefined);
        isUsageActive = false;
    };

    const setUsageStatus = (ctx: StatusContext, text: string | undefined) => {
        ctx.ui.setStatus(KEY, text ? ctx.ui.theme.fg("dim", text) : undefined);
    };

    const clearUsage = (ctx: StatusContext) => {
        closeUsageWidget(ctx);
        setUsageStatus(ctx, undefined);
    };

    const stopAutoRefresh = () => {
        if (!refreshTimer) return;
        clearInterval(refreshTimer);
        refreshTimer = undefined;
    };

    const showUsageError = (ctx: StatusContext, message: string, showWidget = false) => {
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
        setUsageStatus(ctx, "Codex usage unavailable");
    };

    const getUsageSnapshot = async (ctx: RuntimeContext, options?: { force?: boolean }) => {
        if (!refreshInFlight) {
            const request = loadUsageSnapshot(config, ctx, options);
            const inFlight = request.finally(() => {
                if (refreshInFlight === inFlight) {
                    refreshInFlight = undefined;
                }
            });
            refreshInFlight = inFlight;
        }
        return await refreshInFlight;
    };

    const refreshUsage = async (ctx: RuntimeContext, options?: { showWidget?: boolean; showLoading?: boolean; force?: boolean }) => {
        if (options?.showLoading) {
            setUsageStatus(ctx, "Codex usage loading...");
        }

        try {
            const snapshot = await getUsageSnapshot(ctx, { force: options?.force });
            if (options?.showWidget || isUsageActive) {
                renderUsage(snapshot, ctx);
                if (options?.showWidget) {
                    isUsageActive = true;
                }
            } else {
                setUsageStatus(ctx, buildStatusText(snapshot));
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
                force: command === "refresh",
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
        "  /codex-usage          Show usage (uses shared cache when fresh)",
        "  /codex-usage refresh  Force a fresh fetch now",
        "  /codex-usage clear    Clear widget + status",
        "  /codex-usage help     Show setup help",
        "",
        "Default endpoint:",
        `  ${DEFAULT_URL}`,
        "",
        "Environment overrides:",
        `  CODEX_USAGE_URL=${config.url}`,
        `  CODEX_USAGE_PROVIDER=${config.provider}`,
        `  CODEX_USAGE_TIMEOUT_MS=${config.timeoutMs}`,
        `  CODEX_USAGE_REFRESH_INTERVAL_MS=${config.refreshIntervalMs}`,
        `  CODEX_USAGE_CACHE_TTL_MS=${config.cacheTtlMs}`,
        "",
        "Multiple pi sessions share a temp-file cache per provider/url.",
        "Set CODEX_USAGE_REFRESH_INTERVAL_MS=0 to disable background refresh.",
        "Set CODEX_USAGE_CACHE_TTL_MS=0 to disable shared cache reuse.",
        "Endpoint must return ChatGPT WHAM-style usage JSON.",
        "",
        "The built-in default adds chatgpt-account-id, originator=pi, and a pi-style User-Agent.",
    ]);
}

async function loadUsageSnapshot(config: Config, ctx: RuntimeContext, options?: { force?: boolean }): Promise<UsageSnapshot> {
    const requestedAt = Date.now();
    const cachedSnapshot = options?.force ? undefined : await readSharedUsageSnapshot(config);
    if (cachedSnapshot && isFreshSnapshot(config, cachedSnapshot)) {
        return cachedSnapshot;
    }

    const lock = await acquireUsageLock(config);
    if (lock) {
        try {
            const latestSnapshot = options?.force ? undefined : await readSharedUsageSnapshot(config);
            if (latestSnapshot && isFreshSnapshot(config, latestSnapshot)) {
                return latestSnapshot;
            }

            const snapshot = await fetchUsage(config, ctx);
            await writeSharedUsageSnapshot(config, snapshot);
            return snapshot;
        } finally {
            await lock.release();
        }
    }

    const waitedSnapshot = await waitForSharedUsageSnapshot(config, {
        waitMs: config.timeoutMs + 2_000,
        minUpdatedAtMs: options?.force ? requestedAt : undefined,
    });
    if (waitedSnapshot && (options?.force ? waitedSnapshot.updatedAt.getTime() >= requestedAt : isFreshSnapshot(config, waitedSnapshot))) {
        return waitedSnapshot;
    }

    const snapshot = await fetchUsage(config, ctx);
    await writeSharedUsageSnapshot(config, snapshot).catch(() => undefined);
    return snapshot;
}

async function readSharedUsageSnapshot(config: Config): Promise<UsageSnapshot | undefined> {
    const { cachePath } = getSharedCachePaths(config);
    try {
        const raw = JSON.parse(await readFile(cachePath, "utf8")) as { snapshot?: SerializedUsageSnapshot };
        return deserializeUsageSnapshot(raw.snapshot);
    } catch {
        return undefined;
    }
}

async function writeSharedUsageSnapshot(config: Config, snapshot: UsageSnapshot): Promise<void> {
    const { dir, cachePath } = getSharedCachePaths(config);
    await mkdir(dir, { recursive: true });
    await writeFile(cachePath, JSON.stringify({ snapshot: serializeUsageSnapshot(snapshot) }), "utf8");
}

async function waitForSharedUsageSnapshot(
    config: Config,
    options: { waitMs: number; minUpdatedAtMs?: number },
): Promise<UsageSnapshot | undefined> {
    const deadline = Date.now() + options.waitMs;
    while (Date.now() < deadline) {
        const snapshot = await readSharedUsageSnapshot(config);
        if (snapshot) {
            const matchesMinTime = options.minUpdatedAtMs === undefined || snapshot.updatedAt.getTime() >= options.minUpdatedAtMs;
            if (matchesMinTime && isFreshSnapshot(config, snapshot)) {
                return snapshot;
            }
        }
        await sleep(LOCK_WAIT_POLL_MS);
    }
    return undefined;
}

function isFreshSnapshot(config: Config, snapshot: UsageSnapshot): boolean {
    return config.cacheTtlMs > 0 && Date.now() - snapshot.updatedAt.getTime() <= config.cacheTtlMs;
}

async function acquireUsageLock(config: Config): Promise<{ release: () => Promise<void> } | undefined> {
    const paths = getSharedCachePaths(config);
    await mkdir(paths.dir, { recursive: true });

    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            await writeFile(paths.lockPath, String(Date.now()), { encoding: "utf8", flag: "wx" });
            return {
                release: async () => {
                    await rm(paths.lockPath, { force: true });
                },
            };
        } catch (error) {
            if (!isAlreadyExistsError(error)) {
                return undefined;
            }

            if (!(await clearStaleUsageLock(paths.lockPath, config.timeoutMs))) {
                return undefined;
            }
        }
    }

    return undefined;
}

async function clearStaleUsageLock(lockPath: string, timeoutMs: number): Promise<boolean> {
    try {
        const lockText = await readFile(lockPath, "utf8");
        const createdAt = Number.parseInt(lockText.trim(), 10);
        const staleAfterMs = Math.max(timeoutMs * 2, LOCK_STALE_AFTER_MS);
        if (!Number.isFinite(createdAt) || Date.now() - createdAt > staleAfterMs) {
            await rm(lockPath, { force: true });
            return true;
        }
    } catch {
        await rm(lockPath, { force: true }).catch(() => undefined);
        return true;
    }

    return false;
}

function isAlreadyExistsError(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function getSharedCachePaths(config: Config): SharedCachePaths {
    const key = createHash("sha1").update(`${config.provider}\0${config.url}`).digest("hex");
    const dir = path.join(os.tmpdir(), "pi-codex-usage");
    return {
        dir,
        cachePath: path.join(dir, `${key}.json`),
        lockPath: path.join(dir, `${key}.lock`),
    };
}

function serializeUsageSnapshot(snapshot: UsageSnapshot): SerializedUsageSnapshot {
    return {
        ...snapshot,
        updatedAt: snapshot.updatedAt.toISOString(),
    };
}

function deserializeUsageSnapshot(raw: SerializedUsageSnapshot | undefined): UsageSnapshot | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    const updatedAt = new Date(raw.updatedAt);
    if (Number.isNaN(updatedAt.getTime())) return undefined;
    return {
        ...raw,
        updatedAt,
    };
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

function renderUsage(snapshot: UsageSnapshot, ctx: StatusContext) {
    ctx.ui.setWidget(KEY, buildWhamWidgetLines(snapshot));
    ctx.ui.setStatus(KEY, ctx.ui.theme.fg("dim", buildStatusText(snapshot)));
}

function buildWhamWidgetLines(snapshot: UsageSnapshot): string[] {
    const lines = [
        "Codex usage",
        "",
        ...(snapshot.plan ? [`Plan: ${capitalize(snapshot.plan)}`] : []),
        ...(snapshot.primary ? [`Session: ${formatWindow(snapshot.primary)}`] : []),
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
    const parts: string[] = [];

    if (snapshot.primary) {
        parts.push(formatStatusWindow("5hr", snapshot.primary));
    }

    if (snapshot.secondary) {
        parts.push(formatStatusWindow("7d", snapshot.secondary));
    }

    if (parts.length === 0) {
        return "Codex usage ready";
    }

    return `Codex: ${parts.join(" | ")}`;
}

function formatStatusWindow(label: string, window: RateWindow): string {
    const left = `${Math.round(100 - window.usedPercent)}% left`;
    const reset = window.resetAfterSeconds ? ` (↪${formatStatusReset(window.resetAfterSeconds)})` : "";
    return `${label} ${left}${reset}`;
}

function formatWindow(window: RateWindow): string {
    const pct = `${Math.round(100 - window.usedPercent)}%`;
    const reset = window.resetAfterSeconds ? ` · resets in ${formatRelativeSeconds(window.resetAfterSeconds)}` : "";
    return `${pct} left${reset}`;
}

function readConfig(): Config {
    const refreshIntervalMs = parseRefreshInterval(process.env.CODEX_USAGE_REFRESH_INTERVAL_MS);
    return {
        provider: process.env.CODEX_USAGE_PROVIDER?.trim() || DEFAULT_PROVIDER,
        url: process.env.CODEX_USAGE_URL?.trim() || DEFAULT_URL,
        timeoutMs: parseTimeout(process.env.CODEX_USAGE_TIMEOUT_MS),
        refreshIntervalMs,
        cacheTtlMs: parseCacheTtl(process.env.CODEX_USAGE_CACHE_TTL_MS, refreshIntervalMs),
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

function parseCacheTtl(value: string | undefined, refreshIntervalMs: number): number {
    const parsed = Number.parseInt(value ?? "", 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    return refreshIntervalMs > 0 ? refreshIntervalMs : DEFAULT_CACHE_TTL_MS;
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

function formatStatusReset(seconds: number): string {
    if (seconds <= 0) return "now";

    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    if (days > 0) {
        return hours > 0 ? `${days}d${hours}h` : `${days}d`;
    }
    if (hours > 0) {
        return minutes > 0 ? `${hours}hr${minutes}min` : `${hours}hr`;
    }
    if (minutes > 0) {
        return `${minutes}min`;
    }
    return `${seconds}s`;
}

function capitalize(value: string): string {
    return value.length > 0 ? value[0].toUpperCase() + value.slice(1) : value;
}

function truncate(value: string, maxLength: number): string {
    const compact = value.replace(/\s+/g, " ").trim();
    return compact.length > maxLength ? `${compact.slice(0, maxLength)}…` : compact;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
