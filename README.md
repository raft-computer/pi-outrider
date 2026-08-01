# pi-outrider

Inspired from https://stencil.so/blog/prewalk  

Thin model-handoff protocol for [Pi](https://pi.dev). A strong guide model starts a task, explores the repository, signals that the implementation direction is ready, and makes the first meaningful code modification. The runtime then switches to a cheaper executor model in the same session.

What the executor inherits is the `handoff` setting:

- `"plan"` (default since 0.4): the guide must submit a self-contained handoff plan before readiness counts, and after the switch the guide's exploration is pruned from the LLM context on every request. The executor works from the task messages, the plan, and the working tree; it re-reads the code itself. Writing the plan forces the guide to explore deeply, and the executor starts from a clean slate instead of inheriting the guide's early misreadings.
- `"trajectory"`: the pre-0.4 behavior. The executor inherits the full conversation trajectory (exploration, tool results, checklist, working tree). Cheapest when the task's hard part is compressible and the guide's trajectory is trustworthy.

## Installation

```sh
pi install npm:pi-outrider
```

To install it only for the current project, use `pi install -l npm:pi-outrider`. Run `/reload` in an open session to pick it up.

## Configuration

`.pi/outrider.json` in the working directory (per project), falling back to `~/.pi/agent/outrider.json` (global). Resolved when arming, so different projects can pin different model pairs. If neither exists, the global one is created with placeholder values on first `/outrider`.

```json
{
	"guideModel": { "provider": "openai-codex", "id": "gpt-5.6-sol", "thinking": "xhigh" },
	"executorModel": { "provider": "openai-codex", "id": "gpt-5.6-luna", "thinking": "medium" },
	"ignoredPaths": [".git/**", ".pi/**", "tmp/**", "temp/**", "*.md", "TODO", "TODO.*"],
	"armForNextTaskOnly": true,
	"handoff": "plan"
}
```

- `guideModel` / `executorModel`: any model visible in `/model`. Both are resolved and auth-checked when arming; there is no silent fallback.
- `thinking` (optional, per model ref): thinking level for that phase, one of `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Unset inherits the session's level from before Outrider was armed.
- `ignoredPaths`: mutations touching only these paths never trigger the handoff. Patterns containing `/` match the path relative to the working directory; others match the basename (gitignore style). `*` does not cross `/`, `**` does.
- `armForNextTaskOnly`: when `true` (default), one task is guided and the protocol resets to idle on settle. When `false`, it re-arms and switches back to the guide model after each task.
- `handoff`: `"plan"` (default) or `"trajectory"`. Set `"trajectory"` to restore the pre-0.4 behavior exactly.

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
2. The guide has called the `outrider_direction_ready` tool. In plan mode the call must carry a `plan` that clears the minimum bar (at least 400 characters and 8 non-empty lines); a rejected plan does not record readiness, and the tool result tells the guide what is missing.
3. The tool result is not an error.
4. At least one modified path is meaningful (not matched by `ignoredPaths`).

Ordering is strict: readiness first, then the mutation. A mutation made before the signal never triggers a retroactive handoff. The transition is a compare-and-swap (state moves to `handoff_pending` synchronously before the async model switch), so parallel tool results can trigger at most one switch.

On a successful switch, a hidden continuation instruction is appended to the session context (delivered before the next LLM call). In plan mode it contains the executor instruction, the full handoff plan, and the list of files the guide already modified. On failure, the state returns to `guiding`, no instruction is appended, and a warning is shown.

Retry policy: after a failed switch, readiness is kept and the next meaningful mutation retries the handoff automatically. `/outrider cancel` aborts instead.

## Plan handoff and context pruning

In plan mode the guide instruction and the handoff message are injected with marker types. On every LLM request, the extension prunes each closed guide segment (guide marker up to handoff marker) from the outgoing context: the guide's assistant turns and tool results are dropped; user messages, custom messages from other extensions, and the handoff message survive. Everything outside a closed segment is untouched, so an unfinished guide phase and all pre-arm history stay intact.

The pruning is per request and non-destructive: the stored session keeps the full history, `/resume` works normally, and the session log shows everything. After a `/resume`, closed segments from earlier plan handoffs stay pruned, because the markers persist in the session messages.

Trajectory mode never emits these markers, so nothing is ever pruned there.

## Session behavior

Guide and executor run in the same pi session. In trajectory mode the executor sees the entire prior trajectory; in plan mode it sees the pruned context described above. Protocol state is in-memory only: `/reload`, `/new`, `/resume`, and `/fork` rebind the extension and reset to idle. Nothing persists across restarts.

## Tests

```sh
npm test              # portable core: state machine, gate, races, mutation policy
npm run typecheck
```

## Known limitations

- Only `edit` and `write` tool results are observed. File mutations made through `bash` (or custom tools) do not trigger the handoff, because pi does not expose their modified paths.
- Manually running `/model` during a guide phase is not tracked; the protocol keeps going and the handoff still switches to the configured executor.
- In trajectory mode the guide instruction stays in context after the handoff; the executor instruction supersedes it. In plan mode it is pruned with the rest of the guide segment.
- Plan quality is enforced only by a size floor plus the required-section instructions; the runtime cannot judge whether the plan's content is actually right.
- Compaction folds pruned-away guide messages into its summary like any other history; after a compaction that consumes the markers, there is nothing left to prune and the summary may reintroduce guide-phase content in condensed form.
- No cost accounting, benchmarking, rollback, or cross-session handoff (non-goals).
