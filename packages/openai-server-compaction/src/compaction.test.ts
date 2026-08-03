import { afterEach, describe, expect, it, vi } from "vitest";
import { isCompatible, MARKER_PREFIX, normalizedBaseUrl, validateArtifact, type ServerCompactionArtifact } from "./artifact.js";
import { parseCompactionSse, requestCompaction, resolveCodexUrl } from "./compaction.js";
import serverCompaction, { compactionPrefix, latestArtifact, oldPrefixMessages, substitutePayload } from "./index.js";
import { repairResponseItems, toResponseItems } from "./response-items.js";

const model: any = {
  provider: "openai-codex",
  id: "gpt-5.6-sol",
  api: "openai-codex-responses",
  baseUrl: "https://chatgpt.com/backend-api/",
  input: ["text", "image"],
};
const item = { type: "compaction", id: "cmp_1", encrypted_content: "opaque" };
const artifact: ServerCompactionArtifact = {
  version: 1,
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api",
  model: "gpt-5.6-sol",
  api: "openai-codex-responses",
  outputItems: [item],
};

function sse(...events: unknown[]): string {
  return events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
}

function jwt(): string {
  const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-1" } })).toString("base64url");
  return `header.${payload}.signature`;
}

function compactionEntry(id: string, value: unknown, parentId: string | null = null): any {
  return { type: "compaction", id, parentId, timestamp: new Date().toISOString(), summary: "portable", firstKeptEntryId: "kept", tokensBefore: 10, details: { openaiServerCompaction: value } };
}

afterEach(() => vi.unstubAllGlobals());

describe("response item conversion", () => {
  it("preserves encrypted reasoning, ids, phases, calls, outputs, and order", () => {
    const reasoning = { type: "reasoning", id: "rs_1", encrypted_content: "cipher", summary: [] };
    const messages: any[] = [
      { role: "user", content: "start", timestamp: 1 },
      {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: 2,
        stopReason: "toolUse",
        usage: {},
        content: [
          { type: "thinking", thinking: "", thinkingSignature: JSON.stringify(reasoning) },
          { type: "text", text: "checking", textSignature: JSON.stringify({ v: 1, id: "msg_1", phase: "commentary" }) },
          { type: "toolCall", id: "call_1|fc_1", name: "read", arguments: { path: "a" } },
        ],
      },
      { role: "toolResult", toolCallId: "call_1|fc_1", toolName: "read", content: [{ type: "text", text: "done" }], isError: false, timestamp: 3 },
    ];
    expect(toResponseItems(model, messages)).toEqual([
      { role: "user", content: [{ type: "input_text", text: "start" }] },
      reasoning,
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "checking", annotations: [] }], status: "completed", id: "msg_1", phase: "commentary" },
      { type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: '{"path":"a"}' },
      { type: "function_call_output", call_id: "call_1", output: "done" },
    ]);
  });

  it("inserts aborted outputs immediately and removes orphan or wrong-family outputs", () => {
    expect(repairResponseItems([
      { type: "function_call_output", call_id: "orphan", output: "x" },
      { type: "function_call", call_id: "a" },
      { role: "user", content: [] },
      { type: "custom_tool_call", call_id: "b" },
      { type: "function_call_output", call_id: "b", output: "wrong" },
    ])).toEqual([
      { type: "function_call", call_id: "a" },
      { type: "function_call_output", call_id: "a", output: "Tool execution was aborted." },
      { role: "user", content: [] },
      { type: "custom_tool_call", call_id: "b" },
      { type: "custom_tool_call_output", call_id: "b", output: "Tool execution was aborted." },
    ]);
  });

  it("rejects malformed encrypted reasoning instead of losing it", () => {
    const messages: any[] = [{ role: "assistant", content: [{ type: "thinking", thinking: "", thinkingSignature: "not-json" }] }];
    expect(() => toResponseItems(model, messages)).toThrow(/reasoning/);
  });
});

describe("artifact reconstruction and substitution", () => {
  it("normalizes and validates exact compatibility", () => {
    expect(normalizedBaseUrl(" https://x/// ")).toBe("https://x");
    expect(validateArtifact(artifact)).toEqual(artifact);
    expect(isCompatible(artifact, model)).toBe(true);
    expect(isCompatible(artifact, { ...model, id: "gpt-5.6" })).toBe(false);
    expect(isCompatible({ ...artifact, model: "gpt-5.6" }, { ...model, id: "gpt-5.6" })).toBe(true);
    expect(validateArtifact({ ...artifact, outputItems: [] })).toBeUndefined();
  });

  it("uses only the latest active-branch compaction and lets newer invalid entries supersede it", () => {
    expect(latestArtifact([compactionEntry("one", artifact)], model)).toEqual(artifact);
    expect(latestArtifact([compactionEntry("one", artifact), compactionEntry("two", undefined, "one")], model)).toBeUndefined();
    expect(latestArtifact([compactionEntry("fork", artifact)], { ...model, baseUrl: "https://other" })).toBeUndefined();
  });

  it("prepends the prior artifact for repeated compaction or a portable prior summary", () => {
    expect(compactionPrefix([compactionEntry("one", artifact)], model, "portable")).toEqual([item]);
    expect(compactionPrefix([], model, "older summary")).toEqual([{ role: "user", content: [{ type: "input_text", text: "older summary" }] }]);
  });

  it("includes both discarded split-turn segments but not the retained tail", () => {
    const summarized: any = { role: "user", content: "old" };
    const splitPrefix: any = { role: "assistant", content: "discarded turn prefix" };
    const retained: any = { role: "toolResult", content: "retained suffix" };
    expect(oldPrefixMessages({ messagesToSummarize: [summarized], turnPrefixMessages: [splitPrefix] })).toEqual([summarized, splitPrefix]);
    expect(oldPrefixMessages({ messagesToSummarize: [summarized], turnPrefixMessages: [splitPrefix] })).not.toContain(retained);
  });

  it("splices the artifact before the retained tail and clears continuation state", () => {
    const marker = `${MARKER_PREFIX}nonce]]`;
    const payload = {
      previous_response_id: "response-1",
      input: [
        { role: "user", content: [{ type: "input_text", text: marker }] },
        { role: "user", content: [{ type: "input_text", text: "retained tail" }] },
      ],
    };
    expect(substitutePayload(payload, { marker, artifact } as any)).toEqual({ input: [item, payload.input[1]] });
  });

  it("fails on missing, duplicate, or malformed markers", () => {
    const marker = `${MARKER_PREFIX}nonce]]`;
    expect(() => substitutePayload({ input: [{ role: "user", content: marker }] }, undefined)).toThrow(/marker/);
    expect(() => substitutePayload({ input: [{ role: "user", content: marker }, { role: "user", content: marker }] }, { marker, artifact } as any)).toThrow(/marker/);
    expect(() => substitutePayload({ input: [{ role: "user", content: `${MARKER_PREFIX}other]]` }] }, { marker, artifact } as any)).toThrow(/marker/);
  });
});

describe("HTTP and SSE", () => {
  it("resolves native endpoints", () => {
    expect(resolveCodexUrl("https://x/codex/ ")).toBe("https://x/codex/responses");
    expect(resolveCodexUrl("https://x/backend-api")).toBe("https://x/backend-api/codex/responses");
  });

  it("requires response.completed and exactly one consistent encrypted item", () => {
    expect(parseCompactionSse(sse(
      { type: "response.output_item.done", item },
      { type: "response.completed", response: { output: [item] } },
    ))).toEqual(item);
    expect(() => parseCompactionSse("data: [DONE]\n\n")).toThrow(/completed/);
    expect(() => parseCompactionSse(sse({ type: "response.completed", response: { output: [] } }))).toThrow(/exactly one/);
    expect(() => parseCompactionSse(sse({ type: "response.incomplete" }))).toThrow(/failed/);
    expect(() => parseCompactionSse(sse(
      { type: "response.output_item.done", item },
      { type: "response.completed", response: { output: [item, { ...item, id: "cmp_2" }] } },
    ))).toThrow(/exactly one/);
    expect(() => parseCompactionSse("data: {broken}\n\n")).toThrow(/Malformed/);
  });

  it("sends native headers/body, reuses ordinary fields, and excludes retained/continuation input", async () => {
    const fetchMock = vi.fn(async (_url: any, init: any) => {
      const headers = new Headers(init.headers);
      const body = JSON.parse(init.body);
      expect(headers.get("x-codex-beta-features")).toBe("remote_compaction_v2");
      expect(headers.get("chatgpt-account-id")).toBe("account-1");
      expect(body.tools).toEqual([{ type: "function", name: "read" }]);
      expect(body.previous_response_id).toBeUndefined();
      expect(body.input).toEqual([{ role: "user", content: [] }, { type: "compaction_trigger" }]);
      return new Response(sse({ type: "response.output_item.done", item }, { type: "response.completed", response: {} }), { status: 200 });
    });
    await expect(requestCompaction(model, "system", [{ role: "user", content: [] }], {
      apiKey: jwt(), signal: new AbortController().signal, retries: 0, fetch: fetchMock as any,
      requestTemplate: { input: [{ role: "user", content: "full history and retained tail" }], previous_response_id: "old", tools: [{ type: "function", name: "read" }] },
    })).resolves.toEqual(item);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("retries transient HTTP errors but not malformed success", async () => {
    const transient = vi.fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(new Response(sse({ type: "response.output_item.done", item }, { type: "response.completed", response: {} }), { status: 200 }));
    await requestCompaction(model, "system", [], { apiKey: jwt(), signal: new AbortController().signal, retries: 1, fetch: transient as any });
    expect(transient).toHaveBeenCalledTimes(2);

    const malformed = vi.fn().mockResolvedValue(new Response("data: [DONE]\n\n", { status: 200 }));
    await expect(requestCompaction(model, "system", [], { apiKey: jwt(), signal: new AbortController().signal, retries: 2, fetch: malformed as any })).rejects.toThrow(/completed/);
    expect(malformed).toHaveBeenCalledOnce();
  });

  it("honors abort without retrying", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn((_url: any, init: any) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      controller.abort(new Error("cancelled"));
    }));
    await expect(requestCompaction(model, "system", [], { apiKey: jwt(), signal: controller.signal, retries: 2, fetch: fetchMock as any })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("hook integration", () => {
  it("leaves non-target provider payloads untouched", async () => {
    const handlers = new Map<string, Function>();
    serverCompaction({ on: (name: string, handler: Function) => handlers.set(name, handler) } as any);
    const ctx: any = { model: { ...model, provider: "anthropic", id: "claude", api: "anthropic-messages" } };
    await handlers.get("context")!({ messages: [] }, ctx);
    const payload = { model: "claude", messages: [{ role: "user", content: "hello" }] };
    expect(await handlers.get("before_provider_request")!({ payload }, ctx)).toBe(payload);
  });

  it("reconstructs after restart and substitutes the marker", async () => {
    const handlers = new Map<string, Function>();
    serverCompaction({ on: (name: string, handler: Function) => handlers.set(name, handler) } as any);
    const messages: any[] = [{ role: "compactionSummary", summary: "portable", timestamp: 1 }, { role: "user", content: "tail", timestamp: 2 }];
    const ctx: any = { model, sessionManager: { getBranch: () => [compactionEntry("one", artifact)] } };
    const transformed = await handlers.get("context")!({ messages }, ctx);
    expect(transformed.messages[0].content).toContain(MARKER_PREFIX);
    const payload = { previous_response_id: "old", input: [
      { role: "user", content: [{ type: "input_text", text: transformed.messages[0].content }] },
      { role: "user", content: [{ type: "input_text", text: "tail" }] },
    ] };
    const substituted = await handlers.get("before_provider_request")!({ payload }, ctx);
    expect(substituted).toEqual({ input: [item, payload.input[1]] });
  });

  it("fails closed without leaking malformed markers", async () => {
    const handlers = new Map<string, Function>();
    serverCompaction({ on: (name: string, handler: Function) => handlers.set(name, handler) } as any);
    const ctx: any = { model, sessionManager: { getBranch: () => [compactionEntry("one", artifact)] } };
    await handlers.get("context")!({ messages: [{ role: "compactionSummary" }] }, ctx);
    const result = await handlers.get("before_provider_request")!({ payload: { input: [{ role: "user", content: "marker was lost" }] } }, ctx);
    expect(JSON.stringify(result)).not.toContain(MARKER_PREFIX);
    expect(result.model).toContain("fail_closed");
  });

  it("cancels on remote failure so Pi cannot run its normal summarizer", async () => {
    const handlers = new Map<string, Function>();
    serverCompaction({ on: (name: string, handler: Function) => handlers.set(name, handler) } as any);
    const notify = vi.fn();
    const ctx: any = {
      model,
      getSystemPrompt: () => "system",
      ui: { notify },
      modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: false, error: "no auth" }) },
    };
    const result = await handlers.get("session_before_compact")!({ preparation: {}, branchEntries: [], signal: new AbortController().signal }, ctx);
    expect(result).toEqual({ cancel: true });
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("no auth"), "error");
  });
});
