# @baggiiiie/pi-codex-usage

A pi package that adds the `/codex-usage` command and status widget.

## Install

```bash
pi install /path/to/pi-stuff/packages/codex-usage
```

Or after publishing:

```bash
pi install npm:@baggiiiie/pi-codex-usage
```

## Usage

```text
/codex-usage
/codex-usage clear
/codex-usage help
```

## Notes

Run `/login` in pi and choose ChatGPT Plus/Pro (Codex) before using the default endpoint.

The package now refreshes in the background every 5 minutes by default instead of on every `turn_end`.

Optional environment overrides:

```bash
CODEX_USAGE_REFRESH_INTERVAL_MS=300000   # 5 min default
CODEX_USAGE_REFRESH_INTERVAL_MS=0        # disable background refresh
```
