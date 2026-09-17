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

## Install

```bash
pi install npm:@baggiiiie/pi-executor
```

## Configure

Create `~/.pi/agent/extensions/pi-executor.json`:

```json
{
  "url": "http://localhost:4789",
  "authToken": "your-executor-token"
}
```

`url` may be either the Executor origin or its full `/mcp` URL. The extension
adds `/mcp` when needed, sends the token as `Authorization: Bearer ...`, and
connects with MCP Streamable HTTP. Restart Pi after changing the file.

The config follows Pi's agent directory, so `PI_CODING_AGENT_DIR` changes its
location. Because it contains a credential, restrict its permissions:

```bash
chmod 600 ~/.pi/agent/extensions/pi-executor.json
```

## Pi tool

The extension adds one tool, `executor`, and enables it as soon as Pi loads:

- `{ code }` — run TypeScript in Executor's QuickJS sandbox
- `{ operation: "skill", name? }` — fetch the current code-mode guide
- `{ operation: "resume", executionId, ... }` — continue a paused execution

Typical flow:

1. Call `executor({ operation: "skill", name: "execute" })` once for the current workflow.
2. Call `executor({ code })` with a TypeScript program.
3. If it pauses, follow the returned instructions and call
   `executor({ operation: "resume", executionId, ... })`.

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
/executor                  Show the configured MCP target
/executor help             Show the config path and expected shape
```

Executor requires Node.js 20 or newer.
