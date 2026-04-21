# @baggiiiie/pi-context-status

A pi package that shows current context-window usage in the status line or a custom footer.

## Install

```bash
pi install /path/to/pi-stuff/packages/context-status
```

Or after publishing:

```bash
pi install npm:@baggiiiie/pi-context-status
```

## Usage

```text
/context-status status
/context-status footer
/context-status off
/context-status refresh
/context-status help
```

By default the extension uses compact `status` mode. Override the startup mode with:

```bash
export PI_CONTEXT_STATUS_MODE=footer   # or status / off
```

## Notes

- Reuses pi's current context-window estimate from `ctx.getContextUsage()` when available
- Falls back to a local estimate right after compaction, before pi has fresh context usage
- Footer mode preserves a line for other extension statuses
