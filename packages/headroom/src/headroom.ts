import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";

// Minimal Headroom bridge for Pi.
// It only changes large toolResult text in the context sent to the model.
// It does not mutate Pi session history, user prompts, assistant messages, or tool ids.

const STATUS_KEY = "headroom";
const BASE_URL = (process.env.PI_HEADROOM_URL || "http://127.0.0.1:8788").replace(/\/+$/, "");
const ALLOW_REMOTE = boolEnv("PI_HEADROOM_ALLOW_REMOTE", false);
const MIN_CONTEXT_TOKENS = numberEnv("PI_HEADROOM_MIN_CONTEXT_TOKENS", 20_000);
const MIN_TOOL_CHARS = numberEnv("PI_HEADROOM_MIN_TOOL_CHARS", 2_000);
const TIMEOUT_MS = numberEnv("PI_HEADROOM_TIMEOUT_MS", 30_000);
const HEALTH_TIMEOUT_MS = numberEnv("PI_HEADROOM_HEALTH_TIMEOUT_MS", 1_000);
const OFFLINE_BACKOFF_MS = numberEnv("PI_HEADROOM_OFFLINE_BACKOFF_MS", 30_000);
const MAX_CACHE_ENTRIES = numberEnv("PI_HEADROOM_MAX_CACHE_ENTRIES", 200);

type AgentMessage = ContextEvent["messages"][number];
type AnyMessage = AgentMessage & Record<string, unknown>;

type OpenAIMessage =
    | { role: "user"; content: string }
    | { role: "assistant"; content: string | null; tool_calls?: OpenAIToolCall[] }
    | { role: "tool"; content: string; tool_call_id: string };

type OpenAIToolCall = {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
};

type Mapping = {
    sourceIndex: number;
    message: OpenAIMessage;
    originalText: string;
    compress: boolean;
    cacheKey?: string;
};

type CompressResponse = {
    messages?: OpenAIMessage[];
    tokens_saved?: number;
};

type State = {
    enabled: boolean;
    online: boolean | null;
    offlineUntil: number;
    attempts: number;
    applied: number;
    saved: number;
    lastError?: string;
};

export default function headroomSimple(pi: ExtensionAPI) {
    const state: State = { enabled: true, online: null, offlineUntil: 0, attempts: 0, applied: 0, saved: 0 };
    const cache = new Map<string, string>();

    pi.on("session_start", (_event, ctx) => {
        refreshStatus(ctx, state);
        void updateHealth(ctx, state);
    });

    pi.on("context", async (event, ctx) => {
        if (!state.enabled) return;
        if (remoteBlocked()) {
            state.lastError = `remote proxy blocked: ${BASE_URL}`;
            refreshStatus(ctx, state);
            return;
        }

        const usage = ctx.getContextUsage();
        if (typeof usage?.tokens === "number" && usage.tokens < MIN_CONTEXT_TOKENS) return;

        const mappings = buildMappings(event.messages);
        const candidates = mappings.filter((m) => m.compress);
        if (candidates.length === 0) return;

        let cachedCount = 0;
        for (const mapping of candidates) {
            const cached = mapping.cacheKey ? cache.get(mapping.cacheKey) : undefined;
            if (cached && cached !== mapping.originalText) {
                mapping.message.content = cached;
                cachedCount++;
            }
        }

        if (cachedCount === candidates.length) {
            const nextMessages = applyCompressed(event.messages, mappings, mappings.map((m) => m.message));
            if (nextMessages) return { messages: nextMessages };
        }

        if (state.online === false && Date.now() < state.offlineUntil) return;
        if (!(await updateHealth(ctx, state))) return;

        try {
            state.attempts++;
            refreshStatus(ctx, state);

            const compressed = await compress(mappings.map((m) => m.message), ctx.model?.id, ctx.signal);
            if (!compressed.messages || compressed.messages.length !== mappings.length) return;

            const nextMessages = applyCompressed(event.messages, mappings, compressed.messages);
            if (!nextMessages) return;

            for (let i = 0; i < mappings.length; i++) {
                const mapping = mappings[i];
                const after = compressed.messages[i];
                if (!mapping.compress || !mapping.cacheKey || after?.role !== "tool") continue;

                const text = sanitizeCompressedText(after.content);
                if (text !== mapping.originalText) cacheSet(cache, mapping.cacheKey, text);
            }

            state.applied++;
            state.saved += Math.max(0, compressed.tokens_saved ?? 0);
            state.lastError = undefined;
            refreshStatus(ctx, state);
            return { messages: nextMessages };
        } catch (error) {
            state.online = false;
            state.offlineUntil = Date.now() + OFFLINE_BACKOFF_MS;
            state.lastError = error instanceof Error ? error.message : String(error);
            refreshStatus(ctx, state);
            return;
        }
    });

    pi.registerCommand("headroom", {
        description: "Simple local Headroom compression. Usage: /headroom [on|off|health|status]",
        getArgumentCompletions(prefix) {
            return ["on", "off", "health", "status"]
                .filter((value) => value.startsWith(prefix.trim().toLowerCase()))
                .map((value) => ({ value, label: value }));
        },
        handler: async (args, ctx) => {
            const command = args.trim().toLowerCase() || "status";
            if (command === "on") {
                state.enabled = true;
                await updateHealth(ctx, state, 5_000);
            }
            if (command === "off") state.enabled = false;
            if (command === "health") await updateHealth(ctx, state, 5_000);
            refreshStatus(ctx, state);
            ctx.ui.notify(renderStatus(state), state.online === false ? "warning" : "info");
        },
    });
}

function buildMappings(messages: AgentMessage[]): Mapping[] {
    const mappings: Mapping[] = [];

    for (let sourceIndex = 0; sourceIndex < messages.length; sourceIndex++) {
        const source = messages[sourceIndex] as AnyMessage;
        const message = toOpenAIMessage(source);
        if (!message) continue;

        const originalText = openAIText(message);
        const compress = source.role === "toolResult" && originalText.length >= MIN_TOOL_CHARS;
        mappings.push({
            sourceIndex,
            message,
            originalText,
            compress,
            cacheKey: compress && message.role === "tool" ? `${message.tool_call_id}:${hash(originalText)}` : undefined,
        });
    }

    return mappings;
}

function toOpenAIMessage(message: AnyMessage): OpenAIMessage | undefined {
    if (message.role === "user") {
        const content = textFromContent(message.content);
        return content ? { role: "user", content } : undefined;
    }

    if (message.role === "assistant") {
        const content = textFromContent(message.content);
        const tool_calls = toolCallsFromContent(message.content);
        if (!content && tool_calls.length === 0) return undefined;
        return { role: "assistant", content: content || null, tool_calls: tool_calls.length ? tool_calls : undefined };
    }

    if (message.role === "toolResult") {
        const tool_call_id = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
        if (!tool_call_id) return undefined;
        return { role: "tool", tool_call_id, content: textFromContent(message.content) };
    }

    return undefined;
}

function toolCallsFromContent(content: unknown): OpenAIToolCall[] {
    if (!Array.isArray(content)) return [];

    return content.flatMap((part) => {
        if (!isRecord(part) || part.type !== "toolCall" || typeof part.id !== "string") return [];
        return [{
            id: part.id,
            type: "function" as const,
            // Headroom skips some common tool names. Use a neutral name in the
            // compression request only; Pi's real tool metadata is preserved.
            function: { name: "pi_tool_result", arguments: "{}" },
        }];
    });
}

function applyCompressed(
    originalMessages: AgentMessage[],
    mappings: Mapping[],
    compressedMessages: OpenAIMessage[],
): AgentMessage[] | undefined {
    const nextMessages = structuredClone(originalMessages) as AgentMessage[];
    let changed = 0;

    for (let i = 0; i < mappings.length; i++) {
        const mapping = mappings[i];
        if (!mapping.compress) continue;

        const before = mapping.message;
        const after = compressedMessages[i];

        if (before.role !== "tool" || after?.role !== "tool") return undefined;
        if (before.tool_call_id !== after.tool_call_id) return undefined;

        const afterText = sanitizeCompressedText(after.content);
        if (mapping.originalText === afterText) continue;

        const target = nextMessages[mapping.sourceIndex] as AnyMessage;
        if (target.role !== "toolResult") return undefined;
        if (!replaceTextContent(target, afterText)) return undefined;
        changed++;
    }

    return changed > 0 ? nextMessages : undefined;
}

async function compress(messages: OpenAIMessage[], model: string | undefined, signal?: AbortSignal): Promise<CompressResponse> {
    const response = await fetch(`${BASE_URL}/v1/compress`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages, model: model || "gpt-4o" }),
        signal: withTimeout(signal, TIMEOUT_MS),
    });

    if (!response.ok) throw new Error(`Headroom /v1/compress HTTP ${response.status}`);
    return (await response.json()) as CompressResponse;
}

async function updateHealth(ctx: ExtensionContext, state: State, timeoutMs = HEALTH_TIMEOUT_MS): Promise<boolean> {
    if (remoteBlocked()) {
        state.online = false;
        state.offlineUntil = Date.now() + OFFLINE_BACKOFF_MS;
        refreshStatus(ctx, state);
        return false;
    }

    try {
        const response = await fetch(`${BASE_URL}/health`, { signal: withTimeout(ctx.signal, timeoutMs) });
        state.online = response.ok;
        state.offlineUntil = response.ok ? 0 : Date.now() + OFFLINE_BACKOFF_MS;
    } catch {
        state.online = false;
        state.offlineUntil = Date.now() + OFFLINE_BACKOFF_MS;
    }

    refreshStatus(ctx, state);
    return state.online === true;
}

function refreshStatus(ctx: ExtensionContext, state: State): void {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(STATUS_KEY, footer(state));
}

function footer(state: State): string {
    if (!state.enabled) return "○ Headroom off";
    if (remoteBlocked()) return "⚠ Headroom remote blocked";
    if (state.online === false) return "○ Headroom offline";
    if (state.saved > 0) return `✓ Headroom saved ${state.saved.toLocaleString()}`;
    return state.online ? "✓ Headroom" : "○ Headroom idle";
}

function renderStatus(state: State): string {
    return [
        "Headroom Simple",
        `  Enabled: ${state.enabled ? "yes" : "no"}`,
        `  URL:     ${BASE_URL}`,
        `  Online:  ${state.online === true ? "yes" : "no/unknown"}`,
        `  Thresholds: context >= ${MIN_CONTEXT_TOKENS.toLocaleString()} tokens, toolResult >= ${MIN_TOOL_CHARS.toLocaleString()} chars`,
        `  Attempts: ${state.attempts}`,
        `  Applied:  ${state.applied}`,
        `  Saved:    ${state.saved.toLocaleString()} tokens`,
        state.lastError ? `  Last error: ${state.lastError}` : undefined,
    ].filter(Boolean).join("\n");
}

function textFromContent(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .filter((part) => isRecord(part) && part.type === "text" && typeof part.text === "string")
        .map((part) => part.text as string)
        .join("\n");
}

function replaceTextContent(message: AnyMessage, text: string): boolean {
    if (typeof message.content === "string") {
        message.content = text;
        return true;
    }

    const content = message.content;
    if (!Array.isArray(content)) return false;

    let replaced = false;
    const nextContent = content.flatMap((part) => {
        if (isRecord(part) && part.type === "text") {
            if (replaced) return [];
            replaced = true;
            return [{ ...part, text }];
        }
        return [part];
    });

    if (!replaced) nextContent.unshift({ type: "text", text });
    message.content = nextContent;
    return true;
}

function sanitizeCompressedText(text: string): string {
    // Headroom can emit CCR retrieval hints like "Retrieve more: hash=...".
    // Pi does not expose a retrieve tool here, so turn them into a useful Pi-native hint.
    return text.replace(
        /\[(.*?(?:compressed|omitted).*?)\.?\s*Retrieve more: hash=[a-f0-9]+\]/gi,
        "[$1. Hint: ask to inspect a narrower range with read offset/limit instead of re-reading everything.]",
    );
}

function openAIText(message: OpenAIMessage): string {
    return message.content || "";
}

function cacheSet(cache: Map<string, string>, key: string, value: string): void {
    if (cache.size >= MAX_CACHE_ENTRIES) {
        const oldest = cache.keys().next().value;
        if (oldest) cache.delete(oldest);
    }
    cache.set(key, value);
}

function remoteBlocked(): boolean {
    if (ALLOW_REMOTE) return false;
    try {
        const host = new URL(BASE_URL).hostname;
        return !["localhost", "127.0.0.1", "::1", "[::1]"].includes(host);
    } catch {
        return true;
    }
}

function hash(text: string): string {
    return createHash("sha256").update(text).digest("hex");
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
    const timeout = AbortSignal.timeout(ms);
    if (!signal) return timeout;
    if (signal.aborted) return signal;
    return AbortSignal.any([signal, timeout]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function numberEnv(name: string, fallback: number): number {
    const value = Number.parseInt(process.env[name] || "", 10);
    return Number.isFinite(value) ? value : fallback;
}

function boolEnv(name: string, fallback: boolean): boolean {
    const value = (process.env[name] || "").toLowerCase();
    if (["1", "true", "yes", "on"].includes(value)) return true;
    if (["0", "false", "no", "off"].includes(value)) return false;
    return fallback;
}
