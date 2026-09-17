# @baggiiiie/pi-approve-for-me

TypeSafe-powered human approval gate for Pi's `bash` tool.

The extension follows Codex's "Approve for me" routing pattern:

1. inspect each model-generated bash command before execution
2. let TypeSafe estimate whether the command presents material risk
3. run low-risk commands automatically
4. require explicit human confirmation for elevated risk
5. fall back to human review if classification fails

If human review is required in print or JSON mode, the command is blocked because
there is no interactive UI. Classifier errors never cause a command to run
automatically.

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

The command and current working directory are sent to TypeSafe for
classification. They are not sent when the extension is disabled.

## Decision policy

TypeSafe returns a calibrated probability that the command needs human approval.
The default threshold is `0.5`, matching Codex Guardian's current default review
threshold. The classifier treats these as elevated risk:

- broad or likely irreversible deletion and overwrite
- privilege, permission, service, or system configuration changes
- credential access or disclosure
- downloaded, generated, obfuscated, or otherwise untrusted code execution
- remote pushes, deployments, publication, and cloud/external-service mutation
- effects that cannot be bounded confidently

Read-only commands and clear, routine, reversible workspace-local operations can
run automatically.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | required | TypeSafe API credential |
| `PI_APPROVE_FOR_ME` | enabled | Set to `0`, `false`, `off`, or `no` to disable |
| `PI_APPROVE_FOR_ME_MODEL` | `jev-latest` | TypeSafe model |
| `PI_APPROVE_FOR_ME_RISK_THRESHOLD` | `0.5` | Approval threshold from `0` to `1` |
| `PI_APPROVE_FOR_ME_TIMEOUT_MS` | `10000` | Timeout per TypeSafe request attempt |
| `PI_APPROVE_FOR_ME_MAX_COMMAND_CHARS` | `20000` | Commands above this size require human review without classification |
| `PI_APPROVE_FOR_ME_BASE_URL` | TypeSafe default | Alternate API base URL |

`TYPESAFE_AI_API_KEY` is also accepted for compatibility with the AI SDK
provider's environment variable name.

## Scope

The extension intercepts model-generated Pi `bash` tool calls. It does not
intercept shell commands entered directly by a human with Pi's `!` or `!!`
shortcuts, and it is an approval gate rather than an operating-system sandbox.
