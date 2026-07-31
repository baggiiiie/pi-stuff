import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_TIMEOUT_MS = 120_000;
const EXECUTOR_SOURCE_DIR = dirname(fileURLToPath(import.meta.url));
const EXECUTOR_TOOL_NAMES = ["executor", "executor_skill", "executor_resume"] as const;

interface ExecutorConfig {
  executable: { command: string; prefixArgs: string[]; source: string };
  baseUrl?: string;
  server?: string;
  scope?: string;
  timeoutMs: number;
  error?: string;
}

interface ExecutorDetails {
  operation: string;
  transport: "mcp" | "cli";
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

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function findBundledExecutor(startDir = EXECUTOR_SOURCE_DIR): string | undefined {
  let current = startDir;
  while (true) {
    const candidate = join(current, "node_modules", "executor", "bin", "executor");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function readExecutorConfig(env: NodeJS.ProcessEnv = process.env): ExecutorConfig {
  const configuredBin = env.PI_EXECUTOR_BIN?.trim();
  const bundledBin = configuredBin ? undefined : findBundledExecutor();
  const baseUrl = env.PI_EXECUTOR_BASE_URL?.trim() || undefined;
  const server = env.PI_EXECUTOR_SERVER?.trim() || undefined;

  return {
    executable: configuredBin
      ? { command: configuredBin, prefixArgs: [], source: "PI_EXECUTOR_BIN" }
      : bundledBin
        ? { command: process.execPath, prefixArgs: [bundledBin], source: "bundled executor" }
        : { command: "executor", prefixArgs: [], source: "PATH" },
    baseUrl,
    server,
    scope: env.PI_EXECUTOR_SCOPE?.trim() || undefined,
    timeoutMs: positiveInteger(env.PI_EXECUTOR_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    error:
      baseUrl && server
        ? "Set only one of PI_EXECUTOR_BASE_URL and PI_EXECUTOR_SERVER."
        : undefined,
  };
}

function targetArgs(config: ExecutorConfig): string[] {
  if (config.error) throw new Error(config.error);
  const args: string[] = [];
  if (config.baseUrl) args.push("--base-url", config.baseUrl);
  if (config.server) args.push("--server", config.server);
  if (config.scope) args.push("--scope", config.scope);
  return args;
}

function cleanOutput(text: string): string {
  return text
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu, "")
    .replace(/\u001b[@-_][0-?]*[ -/]*[@-~]/gu, "")
    .trim();
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

function targetDescription(config: ExecutorConfig): string {
  if (config.error) return `invalid configuration: ${config.error}`;
  if (config.server) return `server profile ${config.server}`;
  if (config.baseUrl) return config.baseUrl;
  return "local Executor MCP (stdio)";
}

function mcpUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/$/u, "");
  if (!path.endsWith("/mcp")) url.pathname = `${path}/mcp`;
  url.searchParams.set("elicitation_mode", "model");
  url.searchParams.set("artifacts", "false");
  return url;
}

function inheritedEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function executorDataDir(): string {
  return resolve(process.env.EXECUTOR_DATA_DIR ?? join(homedir(), ".executor"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonRecord(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function normalizedOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
  } catch {
    return undefined;
  }
}

function authHeader(auth: unknown): string | undefined {
  if (!isRecord(auth) || typeof auth.kind !== "string") return undefined;
  if (auth.kind === "bearer" && typeof auth.token === "string") return `Bearer ${auth.token}`;
  if (auth.kind === "oauth" && typeof auth.accessToken === "string") {
    return `Bearer ${auth.accessToken}`;
  }
  if (auth.kind === "basic" && typeof auth.password === "string") {
    const username = typeof auth.username === "string" ? auth.username : "";
    return `Basic ${Buffer.from(`${username}:${auth.password}`).toString("base64")}`;
  }
  return undefined;
}

async function localAuthHeader(): Promise<string | undefined> {
  const auth = await readJsonRecord(join(executorDataDir(), "server-control", "auth.json"));
  return typeof auth?.token === "string" ? `Bearer ${auth.token}` : undefined;
}

async function resolveHttpTarget(config: ExecutorConfig): Promise<{
  origin: string;
  authorization?: string;
}> {
  const store = await readJsonRecord(join(executorDataDir(), "server-connections.json"));
  const profiles = Array.isArray(store?.profiles) ? store.profiles.filter(isRecord) : [];
  const profile = config.server
    ? profiles.find((candidate) => candidate.name === config.server)
    : profiles.find((candidate) => {
        const connection = isRecord(candidate.connection) ? candidate.connection : undefined;
        const origin =
          typeof connection?.origin === "string"
            ? connection.origin
            : typeof connection?.apiBaseUrl === "string"
              ? connection.apiBaseUrl
              : undefined;
        return (
          origin !== undefined &&
          config.baseUrl !== undefined &&
          normalizedOrigin(origin) === normalizedOrigin(config.baseUrl)
        );
      });

  if (config.server && !profile) {
    throw new Error(
      `No Executor server profile named "${config.server}". Run \`executor server list\` to inspect configured profiles.`,
    );
  }

  const connection = isRecord(profile?.connection) ? profile.connection : undefined;
  const origin =
    typeof connection?.origin === "string"
      ? connection.origin
      : typeof connection?.apiBaseUrl === "string"
        ? connection.apiBaseUrl
        : config.baseUrl;
  if (!origin) throw new Error("Executor HTTP target has no origin.");

  const envToken = process.env.EXECUTOR_API_KEY ?? process.env.EXECUTOR_AUTH_TOKEN;
  const url = new URL(origin);
  const authorization =
    authHeader(connection?.auth) ??
    (envToken ? `Bearer ${envToken}` : undefined) ??
    (["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)
      ? await localAuthHeader()
      : undefined);
  return { origin, authorization };
}

async function createExecutorTransport(config: ExecutorConfig, cwd: string): Promise<Transport> {
  if (config.error) throw new Error(config.error);

  if (config.baseUrl || config.server) {
    const target = await resolveHttpTarget(config);
    return new StreamableHTTPClientTransport(mcpUrl(target.origin), {
      requestInit: target.authorization
        ? { headers: { Authorization: target.authorization } }
        : undefined,
    });
  }

  const args = [
    ...config.executable.prefixArgs,
    "mcp",
    "--elicitation-mode",
    "model",
    "--no-artifacts",
  ];
  if (config.scope) args.push("--scope", config.scope);

  const transport = new StdioClientTransport({
    command: config.executable.command,
    args,
    cwd,
    env: inheritedEnvironment(),
    stderr: "pipe",
  });
  // Drain diagnostics so a noisy child cannot block on a full stderr pipe.
  transport.stderr?.on("data", () => undefined);
  return transport;
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
  const config = readExecutorConfig();
  let client: Client | undefined;
  let clientPromise: Promise<Client> | undefined;
  let clientCwd: string | undefined;

  const closeClient = async () => {
    const current = client ?? (clientPromise ? await clientPromise.catch(() => undefined) : undefined);
    client = undefined;
    clientPromise = undefined;
    clientCwd = undefined;
    await current?.close().catch(() => undefined);
  };

  const getClient = async (cwd: string): Promise<Client> => {
    if (client && clientCwd === cwd) return client;
    if (clientPromise && clientCwd === cwd) return clientPromise;
    if (client || clientPromise) await closeClient();

    clientCwd = cwd;
    clientPromise = (async () => {
      const created = new Client(
        { name: "pi-executor", version: "1.0.0" },
        { capabilities: {} },
      );
      const transport = await createExecutorTransport(config, cwd);
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
      clientCwd = undefined;
      throw error;
    }
  };

  const callMcp = async (input: {
    operation: string;
    toolName: "execute" | "skills" | "resume";
    args: Record<string, unknown>;
    cwd: string;
    signal?: AbortSignal;
    onUpdate?: (result: { content: Array<{ type: "text"; text: string }>; details: unknown }) => void;
  }) => {
    if (config.error) throw new Error(config.error);
    if (input.signal?.aborted) throw new Error("Executor call was cancelled.");

    input.onUpdate?.({
      content: [{ type: "text", text: `${input.operation}…` }],
      details: { operation: input.operation, transport: "mcp" },
    });

    const current = await getClient(input.cwd);
    let raw: unknown;
    try {
      raw = await current.callTool(
        { name: input.toolName, arguments: input.args },
        undefined,
        {
          signal: input.signal,
          timeout: config.timeoutMs > 0 ? config.timeoutMs : 2_147_483_647,
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

  const runCli = async (input: {
    operation: string;
    args: string[];
    cwd: string;
    signal?: AbortSignal;
    includeTarget?: boolean;
  }) => {
    if (config.error) throw new Error(config.error);
    const args = [
      ...config.executable.prefixArgs,
      ...input.args,
      ...(input.includeTarget === false ? [] : targetArgs(config)),
    ];
    const result = await pi.exec(config.executable.command, args, {
      cwd: input.cwd,
      signal: input.signal,
      timeout: config.timeoutMs > 0 ? config.timeoutMs : undefined,
    });

    const stdout = cleanOutput(result.stdout);
    const stderr = cleanOutput(result.stderr);
    if (result.killed) {
      const reason = input.signal?.aborted
        ? "cancelled"
        : config.timeoutMs > 0
          ? `stopped after the ${config.timeoutMs}ms timeout`
          : "stopped";
      throw new Error(`Executor was ${reason}.`);
    }
    if (result.code !== 0) {
      const message = stderr || stdout || `Executor exited with code ${result.code}.`;
      throw new Error(
        truncateHead(message, {
          maxLines: DEFAULT_MAX_LINES,
          maxBytes: DEFAULT_MAX_BYTES,
        }).content,
      );
    }

    const output = [stdout, stderr ? `Executor warnings:\n${stderr}` : ""]
      .filter(Boolean)
      .join("\n\n") || "Executor completed without output.";
    const limited = await truncateOutput(output);
    return {
      content: [{ type: "text" as const, text: limited.text }],
      details: {
        operation: input.operation,
        transport: "cli" as const,
        truncated: limited.truncated,
        fullOutputPath: limited.fullOutputPath,
      } satisfies ExecutorDetails,
    };
  };

  pi.registerTool({
    name: "executor",
    label: "Executor",
    description:
      "Execute TypeScript in Executor's QuickJS sandbox with access to configured integrations through the lazy `tools` proxy. Call executor_skill first when you need the calling workflow. Return the exact value needed from the code; only the execution's output is returned, not the surrounding MCP or HTTP response envelope.",
    promptSnippet: "Run TypeScript in Executor's QuickJS sandbox to call configured integrations",
    promptGuidelines: [
      "Use executor by passing TypeScript code that searches, describes, and calls integrations through `tools.*`; do not ask for separate direct integration tools.",
      "Call executor_skill with name `execute` before the first non-trivial Executor script in a session.",
    ],
    parameters: Type.Object({
      code: Type.String({
        description:
          "TypeScript/JavaScript to execute. Use `return` for data the model must read and `emit` for user-visible MCP content.",
      }),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      return callMcp({
        operation: "Executing in Executor",
        toolName: "execute",
        args: { code: params.code },
        cwd: ctx.cwd,
        signal,
        onUpdate,
      });
    },
  });

  pi.registerTool({
    name: "executor_skill",
    label: "Executor Skill",
    description:
      "Fetch Executor's current code-mode instructions. Use name `execute` to learn how to search the catalog, inspect schemas, call tools, return values, emit files, and handle pauses.",
    promptSnippet: "Fetch Executor's code-mode usage guide",
    parameters: Type.Object({
      name: Type.Optional(
        Type.String({ description: "Skill name. Use `execute`; omit to list available skills." }),
      ),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      return callMcp({
        operation: params.name ? `Fetching Executor skill ${params.name}` : "Listing Executor skills",
        toolName: "skills",
        args: params.name ? { name: params.name } : {},
        cwd: ctx.cwd,
        signal,
        onUpdate,
      });
    },
  });

  pi.registerTool({
    name: "executor_resume",
    label: "Executor Resume",
    description:
      "Resume an Executor code execution paused for authentication, approval, or form input. Use the executionId and requested schema returned by executor.",
    promptSnippet: "Resume a paused Executor code execution",
    parameters: Type.Object({
      executionId: Type.String({ description: "Execution ID returned by executor" }),
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
    async execute(_id, params, signal, onUpdate, ctx) {
      return callMcp({
        operation: "Resuming Executor execution",
        toolName: "resume",
        args: {
          executionId: params.executionId,
          action: params.action ?? "accept",
          content: JSON.stringify(params.content ?? {}),
        },
        cwd: ctx.cwd,
        signal,
        onUpdate,
      });
    },
  });

  const disableExecutorTools = () => {
    const executorTools = new Set<string>(EXECUTOR_TOOL_NAMES);
    pi.setActiveTools(pi.getActiveTools().filter((name) => !executorTools.has(name)));
  };

  const enableExecutorTools = () => {
    pi.setActiveTools([...new Set([...pi.getActiveTools(), ...EXECUTOR_TOOL_NAMES])]);
  };

  pi.on("session_start", () => {
    if (process.env.PI_EXECUTOR === "1") {
      enableExecutorTools();
    } else {
      disableExecutorTools();
    }
  });

  pi.on("session_shutdown", async () => {
    await closeClient();
  });

  pi.registerCommand("use-executor", {
    description: "Enable Executor code-mode tools for this Pi session",
    handler: async (rawArgs, ctx) => {
      const action = rawArgs.trim().toLowerCase() || "on";
      if (action === "on") {
        enableExecutorTools();
        ctx.ui.notify("Executor code-mode tools enabled for this session.", "info");
        return;
      }
      if (action === "off") {
        disableExecutorTools();
        ctx.ui.notify("Executor tools disabled for this session.", "info");
        return;
      }
      if (action === "status") {
        const active = new Set(pi.getActiveTools());
        const enabled = EXECUTOR_TOOL_NAMES.every((name) => active.has(name));
        ctx.ui.notify(`Executor tools are ${enabled ? "enabled" : "disabled"}.`, "info");
        return;
      }
      ctx.ui.notify("Usage: /use-executor [on|off|status]", "warning");
    },
  });

  pi.registerCommand("executor", {
    description: "Show Executor status, integrations, or open its web UI",
    handler: async (rawArgs, ctx) => {
      const subcommand = rawArgs.trim().toLowerCase() || "status";
      if (subcommand === "help") {
        ctx.ui.notify(
          "/executor [status|integrations|open|help]\n" +
            `Code-mode target: ${targetDescription(config)}\n` +
            "Configure with PI_EXECUTOR, PI_EXECUTOR_SERVER, PI_EXECUTOR_BASE_URL, PI_EXECUTOR_SCOPE, PI_EXECUTOR_BIN, or PI_EXECUTOR_TIMEOUT_MS.",
          "info",
        );
        return;
      }

      try {
        if (subcommand === "open") {
          const result = await runCli({
            operation: "Opening Executor",
            args: ["web"],
            cwd: ctx.cwd,
          });
          ctx.ui.notify(result.content[0]?.text ?? "Opened Executor.", "info");
          return;
        }
        if (subcommand === "integrations") {
          const result = await runCli({
            operation: "Listing Executor integrations",
            args: ["tools", "integrations", "--limit", "50"],
            cwd: ctx.cwd,
          });
          ctx.ui.notify(result.content[0]?.text ?? "No integrations returned.", "info");
          return;
        }
        if (subcommand !== "status") {
          ctx.ui.notify("Usage: /executor [status|integrations|open|help]", "warning");
          return;
        }

        const version = await runCli({
          operation: "Checking Executor",
          args: ["--version"],
          cwd: ctx.cwd,
          includeTarget: false,
        });
        ctx.ui.notify(
          `${version.content[0]?.text ?? "Executor is installed."}\nCode-mode target: ${targetDescription(config)}\nCLI: ${config.executable.source}`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
