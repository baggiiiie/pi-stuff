# @baggiiiie/pi-headroom

Tiny Pi extension for local [Headroom](https://github.com/headroomlabs-ai/headroom) compression.

It is intentionally conservative:

- calls only `http://127.0.0.1:8788` by default
- sends converted context to that local proxy, but only applies changes to large Pi `toolResult` text
- never applies changes to user prompts, assistant text, tool ids, or tool names
- fails open if Headroom is offline or returns an unexpected shape
- caches compressed tool results in memory so the same output is not recompressed every turn

## Install

```bash
 pi install npm:@baggiiiie/pi-headroom
```

Install and run Headroom separately:

```bash
pipx install --python python3.13 "headroom-ai[proxy]"
HEADROOM_TELEMETRY=off headroom proxy --host 127.0.0.1 --port 8788 --mode token --no-cache --no-ccr-marker
```

## Commands

- `/headroom` or `/headroom status` — show status
- `/headroom health` — check the local proxy
- `/headroom off` — disable for this Pi session
- `/headroom on` — enable and check the local proxy

## Environment

| Variable | Default |
| --- | --- |
| `PI_HEADROOM_URL` | `http://127.0.0.1:8788` |
| `PI_HEADROOM_ALLOW_REMOTE` | `false` |
| `PI_HEADROOM_MIN_CONTEXT_TOKENS` | `20000` |
| `PI_HEADROOM_MIN_TOOL_CHARS` | `2000` |
| `PI_HEADROOM_TIMEOUT_MS` | `30000` |
| `PI_HEADROOM_HEALTH_TIMEOUT_MS` | `1000` |
| `PI_HEADROOM_OFFLINE_BACKOFF_MS` | `30000` |
| `PI_HEADROOM_MAX_CACHE_ENTRIES` | `200` |
