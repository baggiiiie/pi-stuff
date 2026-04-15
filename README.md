# pi-stuff

My small collection of [pi](https://github.com/badlogic/pi-mono) extension packages, only made possible by the incredible work of art from Mario.

Available packages:
- `@baggiiiie/pi-codex-usage`: shows Codex usage with a command and status widget
- `@baggiiiie/pi-context-chart`: opens a live context usage chart to see which turn blew up current context window
- `@baggiiiie/pi-rtk-rewrite`: proxies pi `bash` tool calls through [rtk](https://github.com/rtk-ai/rtk) before execution

## Install 

Install all packages:
```bash
pi install git:github.com/baggiiiie/pi-stuff
```

or individually:

```bash
pi install npm:@baggiiiie/pi-context-chart
pi install npm:@baggiiiie/pi-rtk-rewrite
pi install npm:@baggiiiie/pi-codex-usage
```

## Packages

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

### `@baggiiiie/pi-rtk-rewrite`

Rewrites Pi `bash` tool calls through [RTK](https://github.com/rtk-ai/rtk) before execution.

![pi-rtk-rewrite screenshot](docs/pi-rtk-rewrite.png)

Commands:

```text
/rtk-rewrite
/rtk-rewrite status
/rtk-rewrite on
/rtk-rewrite off
/rtk-rewrite refresh
/rtk-rewrite test git status
```

Install individually:

```bash
pi install npm:@baggiiiie/pi-rtk-rewrite
```

Notes:
- Install RTK separately and make sure `rtk rewrite` works in your shell.
- Only Pi `bash` tool calls are rewritten.
- If RTK fails or has no rewrite, the original command still runs.
