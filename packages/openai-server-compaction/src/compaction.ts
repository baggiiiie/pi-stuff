import type { Model } from "@earendil-works/pi-ai";

export interface RequestOptions { apiKey: string; headers?: Record<string, string>; signal: AbortSignal; retries?: number; timeoutMs?: number; fetch?: typeof fetch; requestTemplate?: Record<string, unknown> }

export function resolveCodexUrl(baseUrl: string): string {
  const n = baseUrl.trim().replace(/\/+$/, "");
  if (n.endsWith("/codex/responses")) return n;
  if (n.endsWith("/codex")) return `${n}/responses`;
  return `${n}/codex/responses`;
}

function accountId(token: string): string {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    const id = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    if (typeof id === "string" && id) return id;
  } catch { /* reported below */ }
  throw new Error("Codex OAuth token has no ChatGPT account id");
}

export function parseCompactionSse(text: string): Record<string, unknown> {
  let completed = false;
  const doneCandidates: Record<string, unknown>[] = [];
  let completedOutput: unknown[] | undefined;
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") continue;
    let event: any; try { event = JSON.parse(data); } catch { throw new Error("Malformed Codex SSE JSON"); }
    if (event.type === "response.failed" || event.type === "error" || event.type === "response.incomplete") throw new Error("Codex compaction failed");
    if (event.type === "response.output_item.done" && event.item?.type === "compaction") doneCandidates.push(event.item);
    if (event.type === "response.completed") { completed = true; completedOutput = event.response?.output; }
  }
  if (!completed) throw new Error("Codex stream ended without response.completed");
  const completedCandidates = Array.isArray(completedOutput)
    ? completedOutput.filter((item: any) => item?.type === "compaction") as Record<string, unknown>[]
    : [];
  if (doneCandidates.length > 1 || completedCandidates.length > 1) throw new Error("Codex response must contain exactly one valid compaction item");
  if (doneCandidates.length && completedCandidates.length && JSON.stringify(doneCandidates[0]) !== JSON.stringify(completedCandidates[0]))
    throw new Error("Codex compaction output was inconsistent");
  const candidate = doneCandidates[0] ?? completedCandidates[0];
  if (!candidate || typeof candidate.encrypted_content !== "string" || !candidate.encrypted_content.trim())
    throw new Error("Codex response must contain exactly one valid compaction item");
  return candidate;
}

export async function requestCompaction(model: Model<any>, instructions: string, input: unknown[], options: RequestOptions): Promise<Record<string, unknown>> {
  const retries = Math.min(2, Math.max(0, options.retries ?? 2));
  for (let attempt = 0; ; attempt++) {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 120_000);
    const signal = AbortSignal.any([options.signal, timeout]);
    const headers = new Headers(options.headers);
    headers.set("authorization", `Bearer ${options.apiKey}`); headers.set("chatgpt-account-id", accountId(options.apiKey));
    headers.set("originator", "pi"); headers.set("user-agent", "pi (server-compaction)"); headers.set("openai-beta", "responses=experimental");
    headers.set("accept", "text/event-stream"); headers.set("content-type", "application/json"); headers.set("x-codex-beta-features", "remote_compaction_v2");
    let response: Response;
    const template = options.requestTemplate ?? {};
    const { input: _input, previous_response_id: _previousResponseId, ...ordinaryFields } = template;
    const body = {
      ...ordinaryFields,
      model: model.id,
      store: false,
      stream: true,
      instructions,
      input: [...input, { type: "compaction_trigger" }],
      include: ["reasoning.encrypted_content"],
    };
    try { response = await (options.fetch ?? fetch)(resolveCodexUrl(model.baseUrl), { method: "POST", headers, signal, body: JSON.stringify(body) }); }
    catch (error) { if (attempt >= retries || options.signal.aborted) throw error; await sleep(250 * 2 ** attempt, options.signal); continue; }
    if (response.ok) return parseCompactionSse(await response.text());
    if (attempt >= retries || ![408, 429, 500, 502, 503, 504].includes(response.status)) throw new Error(`Codex compaction HTTP ${response.status}`);
    const retryAfterHeader = response.headers.get("retry-after");
    const retryAfter = retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader);
    await sleep(Number.isFinite(retryAfter) ? Math.min(retryAfter * 1000, 10_000) : 250 * 2 ** attempt, options.signal);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => { const timer = setTimeout(resolve, ms); signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true }); });
}
