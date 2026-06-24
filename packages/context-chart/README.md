# @baggiiiie/pi-context-chart

A pi package that visualises context usage two ways:

- A live **chart** rendered in a Glimpse window.
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

For the chart, each historical turn's snapshot is built by calling `buildSessionContext(entries, parentId, byId)` which reconstructs the full message array that was sent to the model for that specific turn. This means each data point reflects the **cumulative** context size at that moment, not just the incremental addition.

Hovering a point also shows the assistant turn's price when pi has pricing data for that turn. If the provider/model has no usable price data, the tooltip shows `unavailable`.

### Cache hit rate

The footer displays a prompt cache hit rate after the context breakdown. It is calculated as:

```
hitRate = cacheRead / (input + cacheRead + cacheWrite)
```

Values are taken from the model's reported usage metadata accumulated across all assistant turns in the current branch. The rate is color-coded: green (≥70%), yellow (≥30%), or dim (<30%). Shows `--` if no prompt tokens have been reported yet.

## Notes

- Requires pi
- The chart requires Glimpse to be installed where Node can resolve it, or `GLIMPSE_PATH` set to `.../glimpseui/src/glimpse.mjs`
- Footer uses pi's `ctx.getContextUsage()` when available, with a local estimate fallback (e.g. right after compaction)
