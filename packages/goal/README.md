# Goal extension

Codex-style persisted goals for pi, based on the `goal` feature released in OpenAI Codex `rust-v0.128.0`.

## How Codex goals work

Codex goals are a persisted “keep working until done” workflow for a thread.

A thread can have one persisted goal object containing:

- objective
- status: `active`, `paused`, `complete`, or `budget_limited`
- optional token budget
- tokens used
- elapsed time used
- created/updated timestamps

Codex exposes user/TUI controls to create, pause, resume, clear, and inspect the goal. It also exposes three model-visible tools:

- `get_goal` — returns the current goal, status, budget, usage, and remaining tokens.
- `create_goal` — creates a new active goal, but only when explicitly requested by user/system/developer instructions. It fails if a goal already exists.
- `update_goal` — only allows `{ "status": "complete" }`. The model cannot pause, resume, clear, or budget-limit goals; those state changes are controlled by the user/system runtime.

When an active goal turn finishes, Codex accounts token/time usage. If the goal is still active, it can automatically enqueue another continuation turn. The continuation prompt tells the model to keep pursuing the objective, avoid repeating completed work, choose the next concrete action, and audit completion against real evidence.

Before marking a goal complete, the model is instructed to perform a completion audit:

- restate the objective as concrete deliverables or success criteria
- map every explicit requirement to concrete evidence
- inspect relevant files, command output, tests, PR state, or other real artifacts
- verify that proxy signals such as tests or manifests actually cover the objective
- treat uncertainty as incomplete
- call `update_goal({ "status": "complete" })` only when no required work remains

If an active goal reaches its token budget, Codex marks it `budget_limited` and sends a wrap-up prompt. The model should stop new substantive work, summarize progress, identify blockers or remaining work, and leave a clear next step. It should still only call `update_goal` if the objective is actually complete.

The key design choice: **the model may complete goals, but it may not pause, resume, clear, or budget-limit them.** This prevents the model from escaping the workflow merely because it is near budget, uncertain, or ready to stop.

## This pi extension

This extension mirrors that design for pi:

- Persisted per-session goal state via custom session entries.
- `/goal` controls to create, pause, resume, clear, and inspect goals.
- Model tools: `get_goal`, `create_goal`, `update_goal`.
- Runtime continuation: active goals automatically enqueue follow-up turns until completed, paused, cleared, or budget-limited.
- Budget accounting: approximate token usage plus elapsed active-turn time; optional `--tokens` budget triggers a budget-limited wrap-up prompt.

## Usage

```text
/goal ship the new auth flow --tokens 50000
/goal status
/goal pause
/goal resume
/goal clear
```

The model can mark completion only by calling `update_goal({ "status": "complete" })` after auditing the objective against real evidence.
