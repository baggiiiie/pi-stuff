import { randomUUID } from "node:crypto";
import { convertToLlm, type ExtensionAPI, type SessionBeforeCompactEvent, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { compatibleModel, isCompatible, MARKER_PREFIX, normalizedBaseUrl, validateArtifact, type ServerCompactionArtifact } from "./artifact.js";
import { requestCompaction } from "./compaction.js";
import { toResponseItems } from "./response-items.js";

const PLACEHOLDER = "Conversation history was compacted by the Codex server. The native encrypted compaction state is retained in this session; this text is a portable fallback only.";
const FALLBACK_INSTRUCTIONS = "You are a coding agent.";

interface Pending { marker: string; artifact: ServerCompactionArtifact }

type Preparation = SessionBeforeCompactEvent["preparation"];

export function oldPrefixMessages(
  preparation: Pick<Preparation, "messagesToSummarize" | "turnPrefixMessages">,
): Preparation["messagesToSummarize"] {
  return [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
}

export function latestArtifact(entries: readonly SessionEntry[], model: Model<any>): ServerCompactionArtifact | undefined {
  const latest = [...entries].reverse().find(e => e.type === "compaction");
  if (!latest) return;
  const details = latest.details && typeof latest.details === "object"
    ? latest.details as Record<string, unknown>
    : undefined;
  const artifact = validateArtifact(details?.openaiServerCompaction);
  return artifact && isCompatible(artifact, model) ? artifact : undefined;
}

export function compactionPrefix(entries: readonly SessionEntry[], model: Model<any>, previousSummary: string | undefined): unknown[] {
  const artifact = latestArtifact(entries, model);
  if (artifact) return artifact.outputItems;
  if (!previousSummary) return [];
  if (previousSummary === PLACEHOLDER) throw new Error("Previous native Codex compaction artifact is missing or incompatible");
  return [{ role: "user", content: [{ type: "input_text", text: previousSummary }] }];
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

export function substitutePayload(payload: unknown, pending: Pending | undefined): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid Codex payload");
  const p = payload as Record<string, unknown>;
  if (!Array.isArray(p.input)) throw new Error("Invalid Codex payload input");
  const markerIndexes = p.input.map((item, i) => strings(item).some(s => s.includes(MARKER_PREFIX)) ? i : -1).filter(i => i >= 0);
  if (!markerIndexes.length) return p;
  if (!pending || markerIndexes.length !== 1 || strings(p.input[markerIndexes[0]]).filter(s => s.includes(MARKER_PREFIX)).length !== 1 ||
      !strings(p.input[markerIndexes[0]]).some(s => s === pending.marker)) throw new Error("Unresolved or malformed compaction marker");
  const input = [...p.input];
  input.splice(markerIndexes[0], 1, ...pending.artifact.outputItems);
  const result: Record<string, unknown> = { ...p, input };
  delete result.previous_response_id;
  return result;
}

function safeFailure(payload: unknown): Record<string, unknown> {
  const p = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  return { ...p, input: [{ type: "input_text", text: "" }], model: "__pi_server_compaction_fail_closed__", previous_response_id: null };
}

export default function serverCompaction(pi: ExtensionAPI): void {
  let pending: Pending | undefined;
  let targetRequest = false;
  let ordinaryRequest: { compatibility: string; payload: Record<string, unknown> } | undefined;

  pi.on("session_before_compact", async (event, ctx) => {
    const model = ctx.model;
    if (!compatibleModel(model)) return;
    try {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok || !auth.apiKey) throw new Error(auth.ok ? "Codex authentication is unavailable" : auth.error);
      const input = [
        ...compactionPrefix(event.branchEntries, model, event.preparation.previousSummary),
        ...toResponseItems(model, convertToLlm(oldPrefixMessages(event.preparation))),
      ];
      const instructions = [ctx.getSystemPrompt() || FALLBACK_INSTRUCTIONS, event.customInstructions]
        .filter(Boolean)
        .join("\n\nCompaction guidance:\n");
      const compatibility = `${model.provider}\n${normalizedBaseUrl(model.baseUrl)}\n${model.id}\n${model.api}`;
      const item = await requestCompaction(model, instructions, input, {
        apiKey: auth.apiKey, headers: auth.headers, signal: event.signal,
        retries: envInt("PI_OPENAI_COMPACTION_RETRIES", 2), timeoutMs: envInt("PI_OPENAI_COMPACTION_TIMEOUT_MS", 120_000),
        requestTemplate: ordinaryRequest?.compatibility === compatibility ? ordinaryRequest.payload : undefined,
      });
      const artifact: ServerCompactionArtifact = { version: 1, provider: "openai-codex", baseUrl: normalizedBaseUrl(model.baseUrl), model: model.id, api: "openai-codex-responses", outputItems: [item] };
      const encChars = typeof item.encrypted_content === "string" ? item.encrypted_content.length : 0;
      ctx.ui?.notify?.(`Native Codex server compaction applied (${event.preparation.tokensBefore} tokens \u2192 encrypted artifact, ${encChars} chars).`, "info");
      return { compaction: { summary: PLACEHOLDER, firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore, details: { openaiServerCompaction: artifact } } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Do not fail closed: let Pi run its normal text summarizer instead of cancelling.
      ctx.ui?.notify?.(`Native Codex compaction failed, falling back to Pi's text summary: ${message}`, "warning");
      return;
    }
  });

  pi.on("context", (event, ctx) => {
    pending = undefined;
    const model = ctx.model;
    if (!compatibleModel(model)) {
      targetRequest = false;
      return;
    }
    targetRequest = true;
    const artifact = latestArtifact(ctx.sessionManager.getBranch(), model);
    if (!artifact) return;
    const index = event.messages.findIndex((m: any) => m.role === "compactionSummary");
    if (index < 0) return;
    const marker = `${MARKER_PREFIX}${randomUUID()}]]`;
    event.messages[index] = { role: "user", content: marker, timestamp: Date.now() } as any;
    pending = { marker, artifact };
    return { messages: event.messages };
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!targetRequest) return event.payload;
    try {
      const result = substitutePayload(event.payload, pending);
      const hasMarker = strings(event.payload).some(s => s.includes(MARKER_PREFIX));
      if (pending && !hasMarker) throw new Error("Compaction marker was lost before serialization");
      if (hasMarker) pending = undefined;
      if (!hasMarker && compatibleModel(ctx.model) && event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)) {
        ordinaryRequest = {
          compatibility: `${ctx.model.provider}\n${normalizedBaseUrl(ctx.model.baseUrl)}\n${ctx.model.id}\n${ctx.model.api}`,
          payload: structuredClone(event.payload as Record<string, unknown>),
        };
      }
      return result;
    } catch (error) {
      pending = undefined;
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui?.notify?.(`Native Codex compaction artifact could not be applied to the request: ${message}`, "error");
      return safeFailure(event.payload);
    }
  });
}

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]); return Number.isInteger(n) && n >= 0 ? n : fallback;
}

export type { ServerCompactionArtifact } from "./artifact.js";
