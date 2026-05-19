# @baggiiiie/pi-codex-usage

A pi package that adds the `/codex-usage` command and status widget.

## Install

Install from npm:
```bash
pi install npm:@baggiiiie/pi-codex-usage
```

## Usage

```text
/codex-usage
/codex-usage refresh
/codex-usage clear
/codex-usage help
```

## Notes

Run `/login` in pi and choose ChatGPT Plus/Pro (Codex) before using the default endpoint.

The package refreshes in the background every 5 minutes by default instead of on every `turn_end`.

Multiple pi sessions now share a small temp-file cache per provider/url, so they usually reuse the same recent usage snapshot instead of all fetching separately.

Optional environment overrides:

```bash
CODEX_USAGE_REFRESH_INTERVAL_MS=300000   # 5 min default
CODEX_USAGE_REFRESH_INTERVAL_MS=0        # disable background refresh
CODEX_USAGE_CACHE_TTL_MS=300000          # shared cache TTL
CODEX_USAGE_CACHE_TTL_MS=0               # disable shared cache reuse
```
