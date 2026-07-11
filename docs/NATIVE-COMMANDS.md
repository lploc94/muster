# Native Muster commands

Host-enforced workflow and task commands. VS Code slash UI, Command Palette, and
CLI (`npm run cli -- …`) share one command core (`src/commands/`).

See also: [`AGENTIC-WORKFLOW-KNOWLEDGE.md`](AGENTIC-WORKFLOW-KNOWLEDGE.md).

## Workflow

| Command | Purpose |
|---------|---------|
| `/think` | Decision brief (planner tools) |
| `/plan` | Structured plan artifact |
| `/approve` | Approve pending plan once |
| `/replan` | Revise plan; keep evidence |
| `/implement` | Implementation phase |
| `/test` | Test evidence |
| `/review` | Review evidence |
| `/debug` | Debug report |
| `/verify` | Verification synthesis |
| `/finish` | Stage outcome proposal (does not seal lifecycle) |

## Task / session

`/new`, `/new <goal>`, `/tasks`, `/status`, `/focus`, `/fork`, `/cancel`,
`/retry`, `/backend`, `/model`, `/mcp`, `/help`

## Utilities

`/context`, `/compact`, `/export [md|json]`, `/archive`

## CLI

```bash
npm run cli -- help
npm run cli -- tasks --json
npm run cli -- approve --yes
```

Noninteractive mutations require `--yes`. Store path: `MUSTER_STORE_PATH` or
`./.muster-tasks.json`.

## Limits

- Planner Bridge cannot `start_task` / `complete_task` / `fail_task` before approval.
- Provider built-in write tools may not be hard-blocked on every ACP backend.
- Lifecycle seal remains user/coordinator-authorized separately from `/finish`.
