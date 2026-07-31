import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
const EXECUTOR_TOOL_NAMES = [
  "executor_search_tools",
  "executor_list_integrations",
  "executor_describe_tool",
  "executor_call_tool",
  "executor_resume",
] as const;

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
  exitCode: number;
  truncated: boolean;
  fullOutputPath?: string;
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
  return "local Executor (auto-started when needed)";
}

export default function executorExtension(pi: ExtensionAPI) {
  const config = readExecutorConfig();

  const runExecutor = async (input: {
    operation: string;
    args: string[];
    cwd: string;
    signal?: AbortSignal;
    onUpdate?: (result: { content: Array<{ type: "text"; text: string }>; details: unknown }) => void;
    includeTarget?: boolean;
  }) => {
    if (config.error) throw new Error(config.error);
    input.onUpdate?.({
      content: [{ type: "text", text: `${input.operation}…` }],
      details: { operation: input.operation },
    });

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
      const truncated = truncateHead(message, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });
      throw new Error(truncated.content);
    }

    const output = [stdout, stderr ? `Executor warnings:\n${stderr}` : ""]
      .filter(Boolean)
      .join("\n\n") || "Executor completed without output.";
    const limited = await truncateOutput(output);
    return {
      content: [{ type: "text" as const, text: limited.text }],
      details: {
        operation: input.operation,
        exitCode: result.code,
        truncated: limited.truncated,
        fullOutputPath: limited.fullOutputPath,
      } satisfies ExecutorDetails,
    };
  };

  pi.registerTool({
    name: "executor_search_tools",
    label: "Executor Search",
    description:
      `Search the configured Executor catalog by intent. Results are truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}. Search before calling an unfamiliar tool.`,
    promptSnippet: "Search the Executor integration catalog for tools by intent",
    promptGuidelines: [
      "Use executor_search_tools to discover an Executor tool, then executor_describe_tool to inspect its input before calling executor_call_tool.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Natural-language capability to find, such as 'send email'" }),
      namespace: Type.Optional(Type.String({ description: "Restrict results to an integration namespace" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 12 })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const args = ["tools", "search", params.query, "--limit", String(params.limit ?? 12)];
      if (params.namespace) args.push("--namespace", params.namespace);
      return runExecutor({ operation: "Searching Executor tools", args, cwd: ctx.cwd, signal, onUpdate });
    },
  });

  pi.registerTool({
    name: "executor_list_integrations",
    label: "Executor Integrations",
    description: "List integrations configured in Executor and their tool counts.",
    promptSnippet: "List integrations connected to Executor",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Optional integration filter" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const args = ["tools", "integrations", "--limit", String(params.limit ?? 50)];
      if (params.query) args.push("--query", params.query);
      return runExecutor({ operation: "Listing Executor integrations", args, cwd: ctx.cwd, signal, onUpdate });
    },
  });

  pi.registerTool({
    name: "executor_describe_tool",
    label: "Executor Describe",
    description: "Show the TypeScript signature and JSON schema for an Executor tool path.",
    promptSnippet: "Inspect an Executor tool's input schema",
    parameters: Type.Object({
      path: Type.String({ description: "Dotted tool path returned by executor_search_tools" }),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      return runExecutor({
        operation: `Describing ${params.path}`,
        args: ["tools", "describe", params.path],
        cwd: ctx.cwd,
        signal,
        onUpdate,
      });
    },
  });

  pi.registerTool({
    name: "executor_call_tool",
    label: "Executor Call",
    description:
      "Invoke a tool from the configured Executor catalog. Executor applies the connection's authentication and per-tool policy. If the result pauses for authentication or approval, report its instructions and use executor_resume afterward.",
    promptSnippet: "Call a configured Executor integration tool",
    parameters: Type.Object({
      path: Type.String({ description: "Exact dotted tool path" }),
      arguments: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: "JSON object matching the schema from executor_describe_tool",
        }),
      ),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      return runExecutor({
        operation: `Calling ${params.path}`,
        args: ["call", params.path, JSON.stringify(params.arguments ?? {})],
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
      "Resume an Executor execution paused for authentication, approval, or form input. Use the execution ID and requested schema from executor_call_tool's result.",
    promptSnippet: "Resume a paused Executor tool execution",
    parameters: Type.Object({
      execution_id: Type.String({ description: "Execution ID returned by the paused call" }),
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
      const action = params.action ?? "accept";
      const args = ["resume", "--execution-id", params.execution_id, "--action", action];
      if (params.content !== undefined) args.push("--content", JSON.stringify(params.content));
      return runExecutor({ operation: "Resuming Executor execution", args, cwd: ctx.cwd, signal, onUpdate });
    },
  });

  const disableExecutorTools = () => {
    const executorTools = new Set<string>(EXECUTOR_TOOL_NAMES);
    pi.setActiveTools(pi.getActiveTools().filter((name) => !executorTools.has(name)));
  };

  const enableExecutorTools = () => {
    pi.setActiveTools([...new Set([...pi.getActiveTools(), ...EXECUTOR_TOOL_NAMES])]);
  };

  // Keep Executor out of the model's initial tool schemas and system prompt.
  // The extension itself remains loaded so it can expose /use-executor.
  pi.on("session_start", () => {
    disableExecutorTools();
  });

  pi.registerCommand("use-executor", {
    description: "Enable Executor tools for this Pi session",
    handler: async (rawArgs, ctx) => {
      const action = rawArgs.trim().toLowerCase() || "on";
      if (action === "on") {
        enableExecutorTools();
        ctx.ui.notify("Executor tools enabled for this session.", "info");
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
            `Target: ${targetDescription(config)}\n` +
            "Configure with PI_EXECUTOR_SERVER, PI_EXECUTOR_BASE_URL, PI_EXECUTOR_SCOPE, PI_EXECUTOR_BIN, or PI_EXECUTOR_TIMEOUT_MS.",
          "info",
        );
        return;
      }

      try {
        if (subcommand === "open") {
          const result = await runExecutor({
            operation: "Opening Executor",
            args: ["web"],
            cwd: ctx.cwd,
          });
          ctx.ui.notify(result.content[0]?.text ?? "Opened Executor.", "info");
          return;
        }
        if (subcommand === "integrations") {
          const result = await runExecutor({
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

        const version = await runExecutor({
          operation: "Checking Executor",
          args: ["--version"],
          cwd: ctx.cwd,
          includeTarget: false,
        });
        ctx.ui.notify(
          `${version.content[0]?.text ?? "Executor is installed."}\nTarget: ${targetDescription(config)}\nCLI: ${config.executable.source}`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
