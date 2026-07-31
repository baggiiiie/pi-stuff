# @baggiiiie/pi-executor

Connect [Pi](https://github.com/earendil-works/pi-mono) to
[Executor](https://github.com/UsefulSoftwareCo/executor) in its native **code
mode**.

The extension connects to Executor over MCP and exposes its QuickJS execution
surface to Pi. Instead of giving the model one Pi tool per integration method,
the model writes a small TypeScript program that searches Executor's catalog,
inspects schemas, calls one or more tools, filters the result in the sandbox,
and returns only the value it needs.

Executor keeps integration credentials and policies. The TypeScript runs in
Executor's QuickJS sandbox, where network access is available only through the
`tools.*` proxy.

Executor tools are disabled in every fresh Pi session by default. Enable them when needed:

```text
/use-executor
```

To enable them automatically when Pi starts, launch it with:

```bash
PI_EXECUTOR=1 pi
```

## Install

```bash
pi install npm:@baggiiiie/pi-executor
```

The package installs the Executor CLI and MCP client as runtime dependencies.
Open Executor and add an integration:

```text
/executor open
```

Or configure it outside Pi:

```bash
executor install
executor web
```

## Pi tools

After `/use-executor`, Pi can call:

- `executor` — run TypeScript in Executor's QuickJS sandbox
- `executor_skill` — fetch Executor's current code-mode guide
- `executor_resume` — resume code paused for authentication, approval, or form input

Typical flow:

1. Call `executor_skill({ name: "execute" })` once for the current workflow.
2. Call `executor({ code })` with a TypeScript program.
3. If it pauses, follow the returned instructions and call `executor_resume`.

Example program:

```ts
const { items } = await tools.search({
  query: "GitHub repository file contents",
  namespace: "github",
  limit: 5,
});
const path = items[0]?.path;
if (!path) return "No matching GitHub tool found.";

const details = await tools.describe.tool({ path });
if (!details.inputTypeScript.includes("owner")) return details.inputTypeScript;

const response = await tools[path]({
  owner: "octocat",
  repo: "Hello-World",
  path: "README",
});
if (!response.ok) throw new Error(response.error.message);

return response.data.content;
```

Only the program's returned/logged output is sent back to Pi. The MCP envelope
and upstream HTTP metadata are not dumped into the model context unless the
program explicitly returns them.

## Commands

```text
/use-executor              Enable code-mode tools for this session
/use-executor off          Disable them again
/use-executor status       Show whether they are active
/executor                  Show CLI and target status
/executor integrations     List configured integrations
/executor open             Open the Executor web UI
/executor help             Show configuration help
```

## Local and remote targets

With no configuration, the extension launches the bundled CLI as an MCP stdio
server using:

```bash
executor mcp --elicitation-mode model --no-artifacts
```

For Executor Cloud or a self-hosted instance, select a named CLI profile. The
extension reads that profile's origin and stored bearer, basic, or OAuth access
token, then connects to its `/mcp` endpoint:

```bash
executor server add work https://your-executor.example
executor login --server work
PI_EXECUTOR_SERVER=work pi
```

You can also provide an origin directly. Authentication comes from a matching
saved profile, `EXECUTOR_API_KEY`, `EXECUTOR_AUTH_TOKEN`, or the local Executor
`auth.json` when connecting to loopback:

```bash
PI_EXECUTOR_BASE_URL=http://127.0.0.1:4788 pi
```

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `PI_EXECUTOR` | unset | Set to `1` to enable Executor tools when Pi starts |
| `PI_EXECUTOR_BASE_URL` | unset | HTTP Executor origin; otherwise use local stdio MCP |
| `PI_EXECUTOR_SERVER` | unset | Named Executor server profile |
| `PI_EXECUTOR_SCOPE` | unset | Workspace containing `executor.jsonc` for local MCP |
| `PI_EXECUTOR_BIN` | bundled CLI | Alternate Executor executable |
| `PI_EXECUTOR_TIMEOUT_MS` | `120000` | Per-execution timeout; `0` uses the maximum timer interval |

Executor requires Node.js 20 or newer.
