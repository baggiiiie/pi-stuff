# @baggiiiie/pi-executor

Connect [Pi](https://github.com/earendil-works/pi-mono) to a running
[Executor](https://github.com/UsefulSoftwareCo/executor) server over MCP.

The extension adds one enabled-by-default Pi tool. Executor runs the model's
TypeScript in its sandbox and provides access to configured integrations
through `tools.*`.

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

`url` can be the server origin or its full `/mcp` endpoint. The extension adds
`/mcp` when needed and sends `authToken` as a bearer token.

Restart Pi after changing the file. Since it contains a credential, restrict
its permissions:

```bash
chmod 600 ~/.pi/agent/extensions/pi-executor.json
```

If `PI_CODING_AGENT_DIR` is set, the config lives under that directory instead
of `~/.pi/agent`.

## Tool

The extension registers one tool named `executor`:

| Input | Purpose |
| --- | --- |
| `{ "code": "..." }` | Run TypeScript |
| `{ "operation": "skill", "name": "execute" }` | Fetch Executor's current code-mode guide |
| `{ "operation": "resume", "executionId": "..." }` | Resume a paused execution |

Pi handles this flow automatically. Only the program's output is returned to
the model.

## Command

Run `/executor` in Pi to show the configured MCP endpoint and config path.
