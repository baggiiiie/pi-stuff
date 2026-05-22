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

## Notes

- Requires pi
- The chart requires Glimpse to be installed where Node can resolve it, or `GLIMPSE_PATH` set to `.../glimpseui/src/glimpse.mjs`
- Footer uses pi's `ctx.getContextUsage()` when available, with a local estimate fallback (e.g. right after compaction)
