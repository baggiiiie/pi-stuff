# @baggiiiie/pi-thinking

A minimal pi package that adds a `/thinking` command for selecting the current
model's thinking level.

## Install

Install from npm:

```bash
pi install npm:@baggiiiie/pi-thinking
```

## Usage

Once installed, restart pi or run `/reload`.

Run `/thinking` to open pi's thinking-level selector. The current level is
preselected, and the list only includes levels supported by the active model.
Press Enter to select a level or Escape to cancel.

The current level is also shown persistently in pi's footer:

```text
Thinking: high
```

## Notes

- Valid levels are `off`, `minimal`, `low`, `medium`, `high`, and `xhigh`.
- The footer updates when the command, pi's built-in controls, or a model change
  alters the active thinking level.
- Non-reasoning models only offer `off`.
