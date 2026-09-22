

# pi-stuff

My small collection of [pi](https://github.com/badlogic/pi-mono) extension packages, only made possible by the incredible work of art from Mario.

Available packages:
- `@baggiiiie/pi-approve-for-me`: uses TypeSafe to auto-run low-risk bash commands and require human approval for elevated risk
- `@baggiiiie/pi-codex-usage`: shows Codex usage with a command and status widget
- `@baggiiiie/pi-context-chart`: opens a live context usage chart to see which turn blew up current context window
- `@baggiiiie/pi-context-status`: shows current context-window usage in Pi's status line or a custom footer
- `@baggiiiie/pi-goal`: Codex-style persisted goals with `/goal` controls and model tools to keep working until done
- `@baggiiiie/pi-no-ansi`: keeps pi `bash` tool output clean for the model by disabling color and stripping ANSI escapes
- `@baggiiiie/pi-openai-server-compaction`: uses native encrypted Codex server-side compaction for supported models

## Install 

Install all packages:
```bash
pi install git:github.com/baggiiiie/pi-stuff
```

or individually:

```bash
pi install npm:@baggiiiie/pi-context-chart
pi install npm:@baggiiiie/pi-context-status
pi install npm:@baggiiiie/pi-goal
pi install npm:@baggiiiie/pi-no-ansi
pi install npm:@baggiiiie/pi-openai-server-compaction
pi install npm:@baggiiiie/pi-codex-usage
pi install npm:@baggiiiie/pi-approve-for-me
```

## Packages

### `@baggiiiie/pi-approve-for-me`

Uses a Codex Guardian-style two-stage TypeSafe review for every model-generated
`bash` tool call. It evaluates a bounded conversation/tool transcript, reuses
only fresh action-bound risk scores, and runs a fresh reviewer for elevated or
invalidated risk. Low-risk commands run automatically; unresolved risk requires
explicit human approval.

Install individually:

```bash
pi install npm:@baggiiiie/pi-approve-for-me
```

Set `TYPESAFE_API_KEY` before starting Pi. See the
[package README](packages/approve-for-me/README.md) for policy and configuration.

### `@baggiiiie/pi-context-chart`

Adds a live context usage chart in a native Glimpse window.

![pi-context-chart screenshot](docs/pi-context-chart.png)

Commands:

```text
/context-chart
/context-chart close
```

Install individually:

```bash
pi install npm:@baggiiiie/pi-context-chart
```

Notes:
- Requires `glimpseui` to be installed where Node can resolve it, or `GLIMPSE_PATH` set to `.../glimpseui/src/glimpse.mjs`.

### `@baggiiiie/pi-context-status`

Shows the current context window in Pi's status area, including an estimated breakdown by system/user/assistant/tools/memory.

Commands:

```text
/context-status status
/context-status footer
/context-status off
/context-status refresh
/context-status help
```

Install individually:

```bash
pi install npm:@baggiiiie/pi-context-status
```

Notes:
- Defaults to compact `status` mode on session start.
- Set `PI_CONTEXT_STATUS_MODE=footer` for an expanded custom footer.
- Falls back to a local estimate right after compaction until Pi has fresh context usage again.

### `@baggiiiie/pi-codex-usage`

Adds a Codex usage command and status widget.

![pi-codex-usage screenshot](docs/pi-codex-usage.png)

Commands:

```text
/codex-usage
/codex-usage refresh
/codex-usage clear
/codex-usage help
```

Install individually:

```bash
pi install npm:@baggiiiie/pi-codex-usage
```

Notes:
- Run `/login` in Pi and choose ChatGPT Plus/Pro (Codex) before using the default endpoint.
- Refreshes in the background every 5 minutes by default.
- Multiple Pi sessions share a small temp-file cache.


### `@baggiiiie/pi-goal`

Codex-style persisted goals for pi: create a goal, and active goals automatically enqueue follow-up turns until completed, paused, cleared, or budget-limited.

Commands:

```text
/goal <objective> [--tokens N]
/goal status
/goal pause
/goal resume
/goal clear
```

Install individually:

```bash
pi install npm:@baggiiiie/pi-goal
```

Notes:
- The model may mark goals complete via `update_goal({ "status": "complete" })`, but cannot pause, resume, clear, or budget-limit them.
- Optional `--tokens` budget triggers a budget-limited wrap-up prompt.

### `@baggiiiie/pi-no-ansi`

Keeps pi `bash` tool output cleaner for the model by disabling common color env settings and stripping ANSI escapes from captured output.

Install individually:

```bash
pi install npm:@baggiiiie/pi-no-ansi
```

Notes:
- Only affects pi `bash` tool calls.
- Intentionally minimal: no commands, no UI, and no command-specific flag rewriting.

### `@baggiiiie/pi-openai-server-compaction`

Uses Codex's native encrypted server-side compaction for Pi's `openai-codex` models, with model-bound artifacts persisted across resume, fork, and repeated compaction.

```bash
pi install npm:@baggiiiie/pi-openai-server-compaction
```

Notes:
- Requires Node.js `>=22.19.0`.

### `@baggiiiie/pi-rtk-rewrite`

Rewrites Pi `bash` tool calls through [RTK](https://github.com/rtk-ai/rtk) before execution.

