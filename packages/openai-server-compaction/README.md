# `@baggiiiie/pi-openai-server-compaction`

Uses Codex's native server-side compaction endpoint instead of a lossy text summary. The encrypted compaction item is stored in the Pi session and restored on resume, fork, tree navigation, and subsequent compactions.

This package enables native server compaction for models using Pi's built-in `openai-codex` provider and `openai-codex-responses` API. Artifacts remain bound to their exact model ID and normalized base URL, so they are never reused across models or endpoints. Other providers use Pi's normal compaction.

```bash
pi install npm:@baggiiiie/pi-openai-server-compaction
```

Authentication is resolved from Pi's model registry (run `/login` and select ChatGPT). Optional environment variables are `PI_OPENAI_COMPACTION_RETRIES` (0–2, default 2) and `PI_OPENAI_COMPACTION_TIMEOUT_MS` (default 120000).

Requires Node.js 22.19 or newer, matching the supported Pi runtime.

## Safety and limitations

Only the old prefix selected by Pi is sent for compaction; the retained tail is never compacted. Repeated compaction prepends the preceding native artifact so earlier history remains represented. A request is persisted only after a complete, valid SSE response containing exactly one encrypted compaction item.

When native server compaction succeeds, the extension posts a TUI notification (token count before compaction and encrypted artifact size). On remote failure it posts a warning and falls back to Pi's normal text summarizer instead of cancelling. The one remaining fail-closed guard is request-time artifact substitution: if the compaction marker is lost, duplicated, or malformed before serialization, the extension returns an intentionally invalid, marker-free payload (surfaced as a provider error and a TUI notice) so native state can never leak as marker text and a stale artifact is never applied to the wrong conversation.

MIT licensed.
