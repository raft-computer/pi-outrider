# pi-outrider

Inspired from https://stencil.so/blog/prewalk  

Thin model-handoff protocol for [Pi](https://pi.dev). A strong guide model starts a task, explores the repository, signals that the implementation direction is ready, and makes the first meaningful code modification. The runtime then switches to a cheaper executor model in the same session. The executor inherits the full conversation trajectory (exploration, tool results, checklist, working tree) and finishes the work.

The trajectory is handed off, not a summarized plan.

## Installation

```sh
pi install npm:pi-outrider
```

To install it only for the current project, use `pi install -l npm:pi-outrider`. Run `/reload` in an open session to pick it up.

## Configuration

`outrider.json` next to `index.ts`. Created with placeholder values on first `/outrider` if missing.

```json
{
	"guideModel": { "provider": "openai-codex", "id": "gpt-5.6-sol" },
	"executorModel": { "provider": "openai-codex", "id": "gpt-5.6-luna" },
	"ignoredPaths": [".git/**", ".pi/**", "tmp/**", "temp/**", "*.md", "TODO", "TODO.*"],
	"armForNextTaskOnly": true
}
```

- `guideModel` / `executorModel`: any model visible in `/model`. Both are resolved and auth-checked when arming; there is no silent fallback.
- `ignoredPaths`: mutations touching only these paths never trigger the handoff. Patterns containing `/` match the path relative to the working directory; others match the basename (gitignore style). `*` does not cross `/`, `**` does.
- `armForNextTaskOnly`: when `true` (default), one task is guided and the protocol resets to idle on settle. When `false`, it re-arms and switches back to the guide model after each task.

## Commands

| Command | Effect |
|---|---|
| `/outrider` | Validate both models, switch to the guide model, arm for the next task |
| `/outrider status` | Show state, model pair, and direction-ready flag |
| `/outrider cancel` | Reset to idle (keeps whatever model is currently active) |

## State machine

```text
IDLE --/outrider--> ARMED --next user task--> GUIDING
GUIDING --direction ready + first meaningful mutation--> HANDOFF_PENDING
HANDOFF_PENDING --switch ok--> EXECUTING --agent settles--> IDLE (or ARMED)
HANDOFF_PENDING --switch fails--> GUIDING
```

## Handoff semantics

The switch happens only when all of these hold, checked on every successful `edit`/`write` tool result during the guide phase:

1. State is `guiding`.
2. The guide has called the `outrider_direction_ready` tool.
3. The tool result is not an error.
4. At least one modified path is meaningful (not matched by `ignoredPaths`).

Ordering is strict: readiness first, then the mutation. A mutation made before the signal never triggers a retroactive handoff. The transition is a compare-and-swap (state moves to `handoff_pending` synchronously before the async model switch), so parallel tool results can trigger at most one switch.

On a successful switch, a hidden executor continuation instruction is appended to the session context (delivered before the next LLM call). On failure, the state returns to `guiding`, no instruction is appended, and a warning is shown.

Retry policy: after a failed switch, readiness is kept and the next meaningful mutation retries the handoff automatically. `/outrider cancel` aborts instead.

## Session behavior

Guide and executor run in the same pi session; the executor sees the entire prior trajectory. Protocol state is in-memory only: `/reload`, `/new`, `/resume`, and `/fork` rebind the extension and reset to idle. Nothing persists across restarts.

## Tests

```sh
npm test              # portable core: state machine, gate, races, mutation policy
npm run typecheck
```

## Known limitations

- Only `edit` and `write` tool results are observed. File mutations made through `bash` (or custom tools) do not trigger the handoff, because pi does not expose their modified paths.
- Manually running `/model` during a guide phase is not tracked; the protocol keeps going and the handoff still switches to the configured executor.
- The guide instruction stays in context after the handoff (thin v1 by design); the executor instruction supersedes it.
- No cost accounting, benchmarking, rollback, or cross-session handoff (non-goals for v1).
