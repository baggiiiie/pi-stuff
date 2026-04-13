# Codex usage extension

This repo includes a project-local pi extension at:

- `.pi/extensions/codex-usage.ts`
- implementation: `src/codex-usage.ts`

## Command

```text
/codex-usage
/codex-usage clear
/codex-usage help
```

## Real endpoint

For pi users logged in with **ChatGPT Plus/Pro (Codex)**, the extension now uses this endpoint by default:

```text
GET https://chatgpt.com/backend-api/wham/usage
```

Along with:

- `Authorization: Bearer <openai-codex access token>`
- `chatgpt-account-id: <account id from token JWT>`
- `originator: pi`
- a pi-style `User-Agent`

## What it returns

The default endpoint returns rate-limit style usage, for example:

```json
{
  "plan_type": "plus",
  "rate_limit": {
    "allowed": true,
    "limit_reached": false,
    "primary_window": {
      "used_percent": 46,
      "limit_window_seconds": 18000,
      "reset_after_seconds": 4269,
      "reset_at": 1776098704
    },
    "secondary_window": {
      "used_percent": 44,
      "limit_window_seconds": 604800,
      "reset_after_seconds": 269592,
      "reset_at": 1776364028
    }
  },
  "additional_rate_limits": null,
  "credits": {
    "has_credits": false,
    "unlimited": false,
    "balance": "0"
  }
}
```

The extension renders the primary and secondary usage windows in pi.

## Overrides

You can still override the endpoint and request behavior:

```bash
export CODEX_USAGE_URL="https://chatgpt.com/backend-api/wham/usage"
export CODEX_USAGE_PROVIDER="openai-codex"
export CODEX_USAGE_METHOD="GET"
export CODEX_USAGE_HEADERS='{"x-foo":"bar"}'
export CODEX_USAGE_AUTH_HEADER="Authorization"
export CODEX_USAGE_AUTH_PREFIX="Bearer"
export CODEX_USAGE_BODY='{"example":true}'
export CODEX_USAGE_TIMEOUT_MS="15000"
```

## Loading in pi

Because the extension is in `.pi/extensions/`, pi should auto-discover it in this repo.

If pi is already running, use:

```text
/reload
```

Then run:

```text
/codex-usage
```
