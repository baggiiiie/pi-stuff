# `@baggiiiie/pi-openai-server-compaction`

Uses Codex's native server-side compaction endpoint instead of a lossy text summary. The encrypted compaction item is stored in the Pi session and restored on resume, fork, tree navigation, and subsequent compactions.

This package enables native server compaction for models using Pi's built-in `openai-codex` provider and `openai-codex-responses` API. Artifacts remain bound to their exact model ID and normalized base URL, so they are never reused across models or endpoints. Other providers use Pi's normal compaction.

```bash
pi install npm:@baggiiiie/pi-openai-server-compaction
```

Authentication is resolved from Pi's model registry (run `/login` and select ChatGPT). Optional environment variables are `PI_OPENAI_COMPACTION_RETRIES` (0–2, default 2) and `PI_OPENAI_COMPACTION_TIMEOUT_MS` (default 120000).

Requires Node.js 22.19 or newer, matching the supported Pi runtime.

## Safety and limitations

Only the old prefix selected by Pi is sent for compaction; the retained tail is never compacted. Repeated compaction prepends the preceding native artifact so earlier history remains represented. A request is persisted only after a complete, valid SSE response containing exactly one encrypted compaction item. Pi 0.79.9 catches extension-hook exceptions, so the extension explicitly cancels compaction on remote failure to prevent fallback to Pi's normal summarizer. Provider-substitution failures return an intentionally invalid, marker-free payload so native state can never leak as marker text; that request surfaces as a provider error.

MIT licensed.
