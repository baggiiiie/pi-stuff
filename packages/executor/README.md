# @baggiiiie/pi-executor

Connect [Pi](https://github.com/earendil-works/pi-mono) to an
[Executor](https://github.com/UsefulSoftwareCo/executor) integration catalog.

The extension bridges Executor's CLI into native Pi tools. Executor keeps the
integration credentials and policies; Pi can search the catalog, inspect a
schema, call a tool, and resume calls paused for authentication or approval.

Executor tools are **off by default** in every fresh Pi session, keeping their
schemas out of the initial prompt. Enable them only when needed:

```text
/use-executor
```

## Install

```bash
pi install npm:@baggiiiie/pi-executor
```

The package installs the Executor CLI as a runtime dependency. Open Executor and
add an integration:

```text
/executor open
```

Or configure it outside Pi:

```bash
executor install
executor web
```

## Pi tools

After running `/use-executor`, Pi can call:

- `executor_search_tools` — search tools by intent
- `executor_list_integrations` — list configured integrations
- `executor_describe_tool` — inspect a tool's TypeScript/JSON schema
- `executor_call_tool` — invoke a tool through Executor's auth and policy layer
- `executor_resume` — resume a paused authentication/approval interaction

The intended flow is **search → describe → call**. When a call pauses, follow
its instructions and then use `executor_resume` with the returned execution ID.
Tool output is capped at Pi's 2,000-line/50KB limits; full truncated output is
saved to a private temporary file.

## Commands

```text
/use-executor              Enable model-facing Executor tools for this session
/use-executor off          Disable them again
/use-executor status       Show whether they are active
/executor                  Show CLI and target status
/executor status           Show CLI and target status
/executor integrations     List configured integrations
/executor open             Open the Executor web UI
/executor help             Show configuration help
```

A new session always starts with the five model-facing tools disabled. The
`/executor` management command remains available so you can inspect or open
Executor before enabling model access.

## Local, cloud, and self-hosted targets

With no configuration, Executor uses its local service and auto-starts the
local daemon when needed.

For Executor Cloud or a self-hosted instance, first create and authenticate a
named server profile with the Executor CLI, then select it when Pi starts:

```bash
executor server add work https://your-executor.example
executor login --server work
PI_EXECUTOR_SERVER=work pi
```

You can also address an endpoint directly:

```bash
PI_EXECUTOR_BASE_URL=http://127.0.0.1:4788 pi
```

A named profile is preferred for authenticated remote servers because Executor
stores the profile's credentials. Do not set `PI_EXECUTOR_SERVER` and
`PI_EXECUTOR_BASE_URL` together.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `PI_EXECUTOR_SERVER` | unset | Named Executor server profile |
| `PI_EXECUTOR_BASE_URL` | unset | Direct Executor server origin |
| `PI_EXECUTOR_SCOPE` | unset | Workspace containing `executor.jsonc` |
| `PI_EXECUTOR_BIN` | bundled CLI | Alternate Executor executable |
| `PI_EXECUTOR_TIMEOUT_MS` | `120000` | Per-call timeout; `0` disables it |

Executor requires Node.js 20 or newer.
