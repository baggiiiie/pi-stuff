import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  getAgentDir,
  truncateHead,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const REQUEST_TIMEOUT_MS = 120_000;
const CONFIG_FILE_NAME = "pi-executor.json";

interface ExecutorConfig {
  url: string;
  authToken: string;
  configPath: string;
}

type ExecutorConfigResult = ExecutorConfig | { configPath: string; error: string };

interface ExecutorDetails {
  operation: string;
  transport: "mcp";
  truncated: boolean;
  fullOutputPath?: string;
}

interface McpContentBlock {
  type?: unknown;
  text?: unknown;
  data?: unknown;
  mimeType?: unknown;
  uri?: unknown;
  name?: unknown;
  resource?: unknown;
}

interface McpToolEnvelope {
  content?: unknown;
  structuredContent?: unknown;
  isError?: unknown;
}

export function executorConfigPath(agentDir: string = getAgentDir()): string {
  return join(agentDir, "extensions", CONFIG_FILE_NAME);
}

export function readExecutorConfig(configPath: string = executorConfigPath()): ExecutorConfigResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    const missing =
      isRecord(error) && error.code === "ENOENT"
        ? `Missing Executor config at ${configPath}.`
        : `Could not read Executor config at ${configPath}.`;
    return { configPath, error: missing };
  }

  if (!isRecord(parsed)) {
    return { configPath, error: `Executor config at ${configPath} must be a JSON object.` };
  }

  const url = typeof parsed.url === "string" ? parsed.url.trim() : "";
  const authToken = typeof parsed.authToken === "string" ? parsed.authToken.trim() : "";
  if (!url || !authToken) {
    return {
      configPath,
      error: `Executor config at ${configPath} requires non-empty "url" and "authToken" strings.`,
    };
  }

  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
  } catch {
    return {
      configPath,
      error: `Executor config "url" must be an absolute HTTP(S) URL: ${url}`,
    };
  }

  return { configPath, url, authToken };
}

async function truncateOutput(output: string): Promise<{
  text: string;
  truncated: boolean;
  fullOutputPath?: string;
}> {
  const truncation = truncateHead(output, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  if (!truncation.truncated) {
    return { text: truncation.content, truncated: false };
  }

  const directory = await mkdtemp(join(tmpdir(), "pi-executor-"));
  const fullOutputPath = join(directory, "output.txt");
  await writeFile(fullOutputPath, output, { encoding: "utf8", mode: 0o600 });
  const text = [
    truncation.content,
    "",
    `[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines ` +
      `(${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). ` +
      `Full output saved to: ${fullOutputPath}]`,
  ].join("\n");
  return { text, truncated: true, fullOutputPath };
}

export function mcpUrl(configuredUrl: string): URL {
  const url = new URL(configuredUrl);
  const path = url.pathname.replace(/\/+$/u, "");
  url.pathname = path.endsWith("/mcp") ? path : `${path}/mcp`;
  url.searchParams.set("elicitation_mode", "model");
  url.searchParams.set("artifacts", "false");
  return url;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireExecutorConfig(result: ExecutorConfigResult): ExecutorConfig {
  if ("error" in result) throw new Error(result.error);
  return result;
}

function createExecutorTransport(config: ExecutorConfig) {
  return new StreamableHTTPClientTransport(mcpUrl(config.url), {
    requestInit: {
      headers: { Authorization: `Bearer ${config.authToken}` },
    },
  });
}

function blockText(block: McpContentBlock): string | undefined {
  if (block.type === "text" && typeof block.text === "string") return block.text;

  if (block.type === "resource" && isRecord(block.resource)) {
    if (typeof block.resource.text === "string") return block.resource.text;
    const label =
      typeof block.resource.uri === "string" ? block.resource.uri : "embedded binary resource";
    return `[Executor emitted ${label}]`;
  }

  if (block.type === "resource_link" && typeof block.uri === "string") {
    return typeof block.name === "string" ? `${block.name}: ${block.uri}` : block.uri;
  }

  if (block.type === "audio") {
    const mime = typeof block.mimeType === "string" ? ` (${block.mimeType})` : "";
    return `[Executor emitted audio content${mime}]`;
  }

  if (block.type !== "image") return JSON.stringify(block);
  return undefined;
}

async function formatMcpResult(
  operation: string,
  raw: unknown,
): Promise<{
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  details: ExecutorDetails;
  isError: boolean;
}> {
  const envelope: McpToolEnvelope = isRecord(raw) ? raw : {};
  const blocks = Array.isArray(envelope.content)
    ? (envelope.content.filter(isRecord) as McpContentBlock[])
    : [];
  const text = blocks.map(blockText).filter((value): value is string => value !== undefined);
  const images = blocks.flatMap((block) =>
    block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string"
      ? [{ type: "image" as const, data: block.data, mimeType: block.mimeType }]
      : [],
  );

  if (text.length === 0 && images.length === 0) {
    if (envelope.structuredContent !== undefined) {
      text.push(JSON.stringify(envelope.structuredContent, null, 2));
    } else if (!isRecord(raw)) {
      text.push(typeof raw === "string" ? raw : JSON.stringify(raw, null, 2));
    } else {
      text.push("Executor completed without output.");
    }
  }

  const limited = await truncateOutput(text.join("\n"));
  return {
    content: [
      ...(limited.text ? [{ type: "text" as const, text: limited.text }] : []),
      ...images,
    ],
    details: {
      operation,
      transport: "mcp",
      truncated: limited.truncated,
      fullOutputPath: limited.fullOutputPath,
    },
    isError: envelope.isError === true,
  };
}

export default function executorExtension(pi: ExtensionAPI) {
  const configResult = readExecutorConfig();
  let client: Client | undefined;
  let clientPromise: Promise<Client> | undefined;

  const closeClient = async () => {
    const pendingClient = clientPromise
      ? await clientPromise.catch(() => undefined)
      : undefined;
    const current = client ?? pendingClient;
    client = undefined;
    clientPromise = undefined;
    await current?.close().catch(() => undefined);
  };

  const getClient = async (config: ExecutorConfig): Promise<Client> => {
    if (client) return client;
    if (clientPromise) return clientPromise;

    clientPromise = (async () => {
      const created = new Client(
        { name: "pi-executor", version: "1.0.0" },
        { capabilities: {} },
      );
      const transport = createExecutorTransport(config);
      try {
        await created.connect(transport);
      } catch (error) {
        await transport.close().catch(() => undefined);
        throw error;
      }
      client = created;
      return created;
    })();

    try {
      return await clientPromise;
    } catch (error) {
      clientPromise = undefined;
      throw error;
    }
  };

  const callMcp = async (input: {
    operation: string;
    toolName: "execute" | "skills" | "resume";
    args: Record<string, unknown>;
    signal?: AbortSignal;
    onUpdate?: (result: { content: Array<{ type: "text"; text: string }>; details: unknown }) => void;
  }) => {
    if (input.signal?.aborted) throw new Error("Executor call was cancelled.");
    const config = requireExecutorConfig(configResult);

    input.onUpdate?.({
      content: [{ type: "text", text: `${input.operation}…` }],
      details: { operation: input.operation, transport: "mcp" },
    });

    const current = await getClient(config);
    let raw: unknown;
    try {
      raw = await current.callTool(
        { name: input.toolName, arguments: input.args },
        undefined,
        {
          signal: input.signal,
          timeout: REQUEST_TIMEOUT_MS,
        },
      );
    } catch (error) {
      await closeClient();
      throw error;
    }

    const result = await formatMcpResult(input.operation, raw);
    if (result.isError) {
      const message = result.content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      throw new Error(message || "Executor execution failed.");
    }
    return { content: result.content, details: result.details };
  };

  pi.registerTool({
    name: "executor",
    label: "Executor",
    description:
      "Use Executor code mode. Pass code to execute TypeScript, operation `skill` to fetch its current instructions, or operation `resume` to continue a paused execution.",
    promptSnippet: "Run TypeScript in Executor's QuickJS sandbox to call configured integrations",
    promptGuidelines: [
      "Use executor by passing TypeScript code that searches, describes, and calls integrations through `tools.*`; do not ask for separate direct integration tools.",
      "Before the first non-trivial script in a session, call executor with operation `skill` and name `execute`.",
    ],
    parameters: Type.Union([
      Type.Object({
        operation: Type.Optional(Type.Literal("execute")),
        code: Type.String({
          description:
            "TypeScript/JavaScript to execute. Use `return` for data the model must read and `emit` for user-visible MCP content.",
        }),
      }),
      Type.Object({
        operation: Type.Literal("skill"),
        name: Type.Optional(
          Type.String({ description: "Skill name. Use `execute`; omit to list available skills." }),
        ),
      }),
      Type.Object({
        operation: Type.Literal("resume"),
        executionId: Type.String({ description: "Execution ID returned by Executor" }),
        action: Type.Optional(
          StringEnum(["accept", "decline", "cancel"] as const, {
            description: "How to answer the pending interaction",
            default: "accept",
          }),
        ),
        content: Type.Optional(
          Type.Record(Type.String(), Type.Unknown(), {
            description: "Form response matching the requested schema; only used with accept",
          }),
        ),
      }),
    ]),
    async execute(_id, params, signal, onUpdate) {
      if (params.operation === "skill") {
        return callMcp({
          operation: params.name
            ? `Fetching Executor skill ${params.name}`
            : "Listing Executor skills",
          toolName: "skills",
          args: params.name ? { name: params.name } : {},
          signal,
          onUpdate,
        });
      }

      if (params.operation === "resume") {
        return callMcp({
          operation: "Resuming Executor execution",
          toolName: "resume",
          args: {
            executionId: params.executionId,
            action: params.action ?? "accept",
            content: JSON.stringify(params.content ?? {}),
          },
          signal,
          onUpdate,
        });
      }

      return callMcp({
        operation: "Executing in Executor",
        toolName: "execute",
        args: { code: params.code },
        signal,
        onUpdate,
      });
    },
  });

  pi.on("session_shutdown", async () => {
    await closeClient();
  });

  pi.registerCommand("executor", {
    description: "Show the configured Executor MCP target",
    handler: async (rawArgs, ctx) => {
      const subcommand = rawArgs.trim().toLowerCase() || "status";
      if (subcommand === "help") {
        ctx.ui.notify(
          "/executor [status|help]\n" +
            `Config: ${configResult.configPath}\n` +
            'Expected JSON: {"url":"http://localhost:4789","authToken":"..."}',
          "info",
        );
        return;
      }

      if (subcommand !== "status") {
        ctx.ui.notify("Usage: /executor [status|help]", "warning");
        return;
      }

      ctx.ui.notify(
        "error" in configResult
          ? configResult.error
          : `Executor MCP target: ${mcpUrl(configResult.url).toString()}\nConfig: ${configResult.configPath}`,
        "error" in configResult ? "error" : "info",
      );
    },
  });
}
