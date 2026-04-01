# pi-context-chart

A [pi](https://github.com/nichochar/pi) extension that opens a live context usage chart in a native [glimpse](https://github.com/hazat/glimpse) window, showing how your token budget is consumed turn by turn.

![type:extension](https://img.shields.io/badge/type-pi%20extension-blue)

## What it does

Adds a `/context-chart` command to pi that opens an interactive stacked area chart visualizing prompt composition across turns:

- **System instructions**: system prompt tokens
- **User input**: your messages
- **Agent output**: assistant responses
- **Tools**: tool calls and results
- **Memory**: compaction summaries, branch summaries, custom entries

The chart updates in real time as you interact with pi, tracking context events, turn completions, session switches, forks, and compactions. Stats cards show current context usage, context window percentage, cumulative token usage, cache hits, and estimated cost.

## Install

```
pi install git:https://github.com/baggiiiie/pi-stuff
```

## Requirements

- Node.js 20+
- [pi](https://github.com/nichochar/pi) installed globally
- [Glimpse](https://github.com/hazat/glimpse) installed globally
- Internet access (Chart.js and Google Fonts CDNs)

## Usage

```
/context-chart          # open the chart window
/context-chart close    # close it
```

The window stays open and updates live across session switches, forks, compactions, and model changes. It closes automatically when the session shuts down.
