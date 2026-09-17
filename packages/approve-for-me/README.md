# @baggiiiie/pi-approve-for-me

TypeSafe-powered human approval gate for Pi's `bash` tool.

The extension adapts two Codex Guardian mechanisms to Pi: asynchronous action
risk scoring and a fresh approval reviewer.

1. when Pi announces a pending bash execution, capture the exact action,
   authorization snapshot, and a bounded transcript
2. start a fast TypeSafe risk score
3. at Pi's blocking `tool_call` boundary, reuse that score only when the command
   is unchanged, authorization is unchanged, and the score is fresh
4. run low-risk commands automatically
5. route elevated, stale, changed, or failed scores to a fresh context-aware
   TypeSafe reviewer
6. auto-run only a confident fresh approval; otherwise require explicit human
   confirmation of the exact command
7. freeze approved tool-call arguments so later extension handlers cannot
   mutate the reviewed action before execution
8. block when review fails and no human UI is available

If human review is required in print or JSON mode, the command is blocked because
there is no interactive UI. Classifier errors never cause a command to run
automatically.

## UI

In Pi's interactive TUI, the footer shows transient review state:

- `◌ TypeSafe reviewing command…`
- `◌ TypeSafe reviewing context · fast risk 82%`
- `! TypeSafe awaiting human approval`
- `✓ TypeSafe allowed · risk 8%` or `✗ TypeSafe blocked by human`

Final allow/block statuses clear after 1.5 seconds. Concurrent reviews collapse
to a single count. Human approval still uses Pi's confirmation dialog; print,
JSON, and RPC modes do not receive the footer indicator.

## Install

```bash
pi install npm:@baggiiiie/pi-approve-for-me
```

For local development:

```bash
pi -e ./packages/approve-for-me/src/approve-for-me.ts
```

## TypeSafe setup

Create a TypeSafe API key and export it before starting Pi:

```bash
export TYPESAFE_API_KEY=...
pi
```

If the key is stored in a `.env` file, source that file into the shell first:

```bash
set -a
source .env
set +a
pi
```

The command, current working directory, authorization metadata, bounded
conversation transcript, and recent human review decisions are sent to
TypeSafe. Common sensitive literals are redacted first, while a local hash
still binds the decision to the exact unredacted action. Context may include
sensitive content that does not match the redactors. Nothing is sent when the
extension is disabled.

## Reviewer context

The retained transcript can include:

- user messages
- surfaced assistant text and tool calls
- bounded tool outputs and their error status
- compaction summaries
- direct human shell evidence already included in Pi's model context
- recent exact-command human approvals and denials

Hidden assistant reasoning is excluded and images are represented only as
omitted placeholders. Message and tool budgets are separate so large command
output cannot evict all user-intent evidence. Common API keys, tokens, bearer
credentials, JWTs, and private keys are redacted locally before context is sent.

## Decision policy

The fast scorer returns a calibrated risk probability. The default threshold is
`0.5`, matching Codex Guardian's current default risk threshold. Above that
threshold, or whenever evidence cannot be reused safely, a second TypeSafe call
acts as the isolated reviewer. It evaluates:

- whether the command is aligned with the user's goal
- whether its material effects and destination were explicitly authorized
- whether retained context is sufficient
- the primary hazard and dangerous-risk probability
- whether to allow automatically, require a human, or recommend denial

The classifier treats these as elevated risk:

- broad or likely irreversible deletion and overwrite
- privilege, permission, service, or system configuration changes
- credential access or disclosure
- downloaded, generated, obfuscated, or otherwise untrusted code execution
- remote pushes, deployments, publication, and cloud/external-service mutation
- effects that cannot be bounded confidently

Read-only commands and clear, routine, reversible workspace-local operations can
run automatically. A fresh reviewer recommendation is auto-applied only when it
is `allow_without_human`, both its confidence and allow probability meet the
configured confidence threshold, risk is below threshold, and context is
sufficient.

Human denials are returned to the agent with instructions not to retry,
rephrase, split, or bypass the decision. Three consecutive denials, or ten
denials in a rolling window of fifty reviews, trips a per-agent-run circuit
breaker.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | required | TypeSafe API credential |
| `PI_APPROVE_FOR_ME` | enabled | Set to `0`, `false`, `off`, or `no` to disable |
| `PI_APPROVE_FOR_ME_MODEL` | `jev-latest` | TypeSafe model |
| `PI_APPROVE_FOR_ME_RISK_THRESHOLD` | `0.5` | Approval threshold from `0` to `1` |
| `PI_APPROVE_FOR_ME_MIN_REVIEWER_CONFIDENCE` | `0.65` | Minimum confidence and allow probability for fresh auto-approval |
| `PI_APPROVE_FOR_ME_TIMEOUT_MS` | `10000` | Timeout per TypeSafe request attempt |
| `PI_APPROVE_FOR_ME_MAX_COMMAND_CHARS` | `4000` | Maximum fully inspectable command size; larger values are capped and larger commands are blocked |
| `PI_APPROVE_FOR_ME_MAX_SCORE_AGE_MS` | `30000` | Maximum reusable fast-score age |
| `PI_APPROVE_FOR_ME_MAX_MESSAGE_CONTEXT_CHARS` | `12000` | Total retained user/assistant context |
| `PI_APPROVE_FOR_ME_MAX_TOOL_CONTEXT_CHARS` | `8000` | Total retained tool-output context |
| `PI_APPROVE_FOR_ME_MAX_CONTEXT_ENTRY_CHARS` | `2000` | Per-entry transcript limit |
| `PI_APPROVE_FOR_ME_MAX_RECENT_NON_USER_ENTRIES` | `20` | Maximum recent non-user transcript entries |
| `PI_APPROVE_FOR_ME_MAX_PREVIOUS_REVIEWS` | `10` | Previous exact-action decisions shown to TypeSafe |
| `PI_APPROVE_FOR_ME_INCLUDE_TOOL_OUTPUTS` | enabled | Set to `0`, `false`, `off`, or `no` for a stricter privacy mode |
| `PI_APPROVE_FOR_ME_POLICY` | unset | Additional local policy included in both review stages |
| `PI_APPROVE_FOR_ME_BASE_URL` | TypeSafe default | Alternate API base URL |

`TYPESAFE_AI_API_KEY` is also accepted for compatibility with the AI SDK
provider's environment variable name.

## Scope

The extension intercepts model-generated Pi `bash` tool calls. It does not
intercept shell commands entered directly by a human with Pi's `!` or `!!`
shortcuts.

Unlike Codex itself, a Pi extension has no built-in sandbox-escalation request
to intercept. This package therefore reviews every model-generated bash action
and remains an approval gate rather than an operating-system sandbox. It cannot
perform Codex Guardian's optional read-only filesystem/network investigations.

The package requires `@earendil-works/pi-coding-agent` 0.79.9 or newer. Because
approved arguments are frozen, extensions that intentionally rewrite bash
arguments must load before this package.
