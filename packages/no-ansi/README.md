# @baggiiiie/pi-no-ansi

A minimal pi package that keeps `bash` tool output cleaner for the model by:

- setting common no-color environment variables for every pi `bash` tool call
- stripping ANSI escape sequences from captured `bash` output before it reaches model context

## Install

Install from npm:
```bash
pi install npm:@baggiiiie/pi-no-ansi
```

## Usage

Once installed, restart pi or run `/reload`.

No commands or configuration required.

## Notes

- This only affects pi `bash` tool calls.
- It preserves raw command execution behavior; it just tweaks env vars and sanitizes returned text.
- It is intentionally minimal and does not add command-specific `--color=never` flags.
- It sets these env vars for every pi `bash` tool call:

```bash
NO_COLOR=1
CLICOLOR=0
FORCE_COLOR=0
TERM=dumb
```
