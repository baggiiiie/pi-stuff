# @baggiiiie/pi-rtk-rewrite

A pi package that rewrites `bash` tool calls through [RTK](https://github.com/rtk-ai/rtk) before execution.

If RTK can optimize a command, pi transparently changes commands like:

```text
git status
```

into:

```text
rtk git status
```

That usually cuts token-heavy shell output by a lot, especially for `git`, `rg`, `find`, tests, builds, and similar commands.

## Install

```bash
pi install /path/to/pi-stuff/packages/rtk-rewrite
```

Or after publishing:

```bash
pi install npm:@baggiiiie/pi-rtk-rewrite
```

## Requirements

Install RTK separately and make sure `rtk rewrite` works in your shell:

```bash
brew install rtk
# or
curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh

rtk rewrite "git status"
```

## Usage

Once installed, restart pi or run `/reload`.

```text
/rtk-rewrite
/rtk-rewrite status
/rtk-rewrite on
/rtk-rewrite off
/rtk-rewrite refresh
/rtk-rewrite test git status
```

## Environment knobs

```bash
PI_RTK_REWRITE_ENABLED=1
PI_RTK_REWRITE_TIMEOUT_MS=2000
PI_RTK_REWRITE_VERBOSE=0
PI_RTK_REWRITE_SHOW_STATUS=1
```

## Notes

- This only rewrites pi `bash` tool calls.
- pi built-in tools like `read`, `edit`, and `write` do not go through RTK.
- The extension never blocks the original bash command if RTK fails or has no rewrite.
