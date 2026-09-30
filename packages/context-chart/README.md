# @baggiiiie/pi-context-chart

A pi package that visualises context usage two ways:

- A live **chart** and **context inspector** rendered in Glimpse, or your default browser if Glimpse is not installed.
- A live **footer** showing the current context-window mix and totals.

Both surfaces share a single computation, so they stay consistent and only recompute once per session event.

## Install

```bash
pi install npm:@baggiiiie/pi-context-chart
```

## Usage

```text
/context-chart           Open the live context usage chart
/context-chart close     Close the chart window
/context-chart footer    Toggle the context footer on/off
/context-chart refresh   Recompute context state (updates chart + footer)
/context-chart help      Show the in-app help widget
/context-chart clear     Hide the help widget
```

The footer is on by default. Override the startup behavior with:

```bash
export PI_CONTEXT_CHART_FOOTER=off   # disable footer on launch (default: on)
```

## Browser fallback and context inspector

When Glimpse cannot be found, `/context-chart` opens a live HTML page in your default browser (macOS, Windows, or Linux with `xdg-open`). The page polls a loopback-only server once per second, using an unguessable URL. `/context-chart close` and session shutdown stop the server; they do not close the browser tab. Closing the tab alone does not stop the server. Browser launch failures are reported rather than silently ignored.

Click **Context inspector** to view the system prompt, active tool definitions, and every ordered context message as expandable JSON (including text, thinking, tool calls/results, and summaries). **Complete raw JSON** shows the whole inspection snapshot. The inspector works even if Chart.js cannot load.

- **Current context**: reconstructed from the active session branch while idle; observed messages while a request is starting.
- **Last observed request**: the latest messages captured by this extension’s `context` event handler, retained after the turn ends. Cleared on session changes, branch navigation, and compaction; not persisted to disk.

These are not guaranteed to be the exact provider HTTP payload: later extensions may modify messages, and provider conversion adds its own formatting. The system prompt and tool definitions are captured separately. Skills show the prompt’s available-skills listing, not the contents of unread skill files. Token counts remain estimates. The page contains potentially sensitive prompt and tool data; do not share its URL or raw JSON casually.

## How tokens are calculated

### Estimation method

Token counts are estimated locally — no tokenizer or API call is involved at estimation time. The primary method is `estimateTokens(message)` exported by `@mariozechner/pi-coding-agent`. If that throws (e.g. for an unrecognized message shape), the fallback is `Math.ceil(textContent.length / 4)` (a rough chars-to-tokens heuristic).

### Message categorization

Each message in the reconstructed context array is classified into one of five buckets based on its `role`:

| Role | Category | Description |
|------|----------|-------------|
| `user` | **User input** | User prompts and follow-ups |
| `assistant` | **Agent output** | Model responses, tool-call blocks, thinking |
| `toolResult`, `bashExecution` | **Tools** | Tool/command outputs returned to the model |
| `compactionSummary`, `branchSummary`, `custom` | **Memory** | Carried context from compaction or branch summaries |
| *(system prompt)* | **System instructions** | Estimated separately from the resolved system prompt string |

The snapshot total is the sum of all five categories:

```
total = systemInstructions + userInput + agentOutput + tools + memory
```

### Reconciliation with actual usage

When pi reports real token counts via `ctx.getContextUsage()` (returned by the provider after a request), the footer uses the **actual** `tokens` value as the authoritative total. The category breakdown is then **scaled proportionally** to match that real total using the largest-remainder method (each category keeps its relative share, with rounding residuals distributed to the largest fractional remainders). This avoids the breakdown summing to a different number than what the provider reported.

If `getContextUsage()` is unavailable (e.g. right after compaction, or for live in-flight snapshots), the local estimate is used and marked as "approximate" (`~` prefix in the footer).

### Per-turn history

For the chart, each historical turn's snapshot is built by calling `buildSessionContext(entries, parentId, byId)` which reconstructs the session message array preceding that turn (not necessarily the exact messages sent after extension transformations). This means each data point reflects the **cumulative** context size at that moment, not just the incremental addition.

Hovering a point also shows the assistant turn's price when pi has pricing data for that turn. If the provider/model has no usable price data, the tooltip shows `unavailable`.

### Turn 0 (initial context)

The chart always starts at **turn 0**, which represents everything already in the context window *before any user message*: the resolved system prompt, project context files, skills, and the tool definitions (JSON schemas) sent to the model. Click turn 0 in the chart to open a breakdown with collapsible sections and per-section token estimates:

- **System prompt** — base instructions
- **Project context** — `# Project Context` files, if any
- **Skills** — the `<available_skills>` block, if any
- **tool: `<name>`** — one section per active tool with its description and parameter schema

Tool-definition tokens are folded into the **System** bucket for every turn (they are present in every request), so the system line stays consistent across turns.

### Cache hit rate

The footer displays a prompt cache hit rate after the context breakdown. It is calculated as:

```
hitRate = cacheRead / (input + cacheRead + cacheWrite)
```

Values are taken from the model's reported usage metadata accumulated across all assistant turns in the current branch. The rate is color-coded: green (≥70%), yellow (≥30%), or dim (<30%). Shows `--` if no prompt tokens have been reported yet.

## Testing

Unit/transport tests (Node with native TypeScript support):

```bash
node --test packages/context-chart/tests/context-chart.test.ts
```

## Notes

- Requires pi
- Glimpse is optional. To use it, install it where Node can resolve it, or set `GLIMPSE_PATH` to `.../glimpseui/src/glimpse.mjs`. If Glimpse is found but fails to start, the error is reported.
- Chart.js is loaded from a CDN and requires network access; the context inspector does not.
- Footer uses pi's `ctx.getContextUsage()` when available, with a local estimate fallback (e.g. right after compaction)
