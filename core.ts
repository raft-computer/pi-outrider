/**
 * Portable Outrider core: protocol state machine, handoff gate, plan
 * validation, and mutation policy. Runtime independent, no pi imports.
 *
 * State machine:
 *   idle -> armed -> guiding -> handoff_pending -> executing -> idle
 *   handoff_pending falls back to guiding when the model switch fails.
 *
 * Handoff media:
 *   "plan" (default): the guide must submit a self-contained handoff plan
 *   before readiness is recorded. After the switch, the guide's exploration
 *   trajectory is pruned from the LLM context; the executor starts from the
 *   task messages, the plan, and the working tree.
 *   "trajectory": the executor inherits the full session trajectory (the
 *   pre-0.4 behavior).
 */

export type OutriderState = "idle" | "armed" | "guiding" | "handoff_pending" | "executing";

export type HandoffMedium = "plan" | "trajectory";

export interface ModelRef {
	provider: string;
	id: string;
	/** Optional per-phase thinking level; unset inherits the session level. */
	thinking?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

export interface MutationResult {
	successful: boolean;
	paths: string[];
}

export interface OutriderConfig {
	guideModel: ModelRef;
	executorModel: ModelRef;
	ignoredPaths: string[];
	armForNextTaskOnly: boolean;
	handoff: HandoffMedium;
}

export interface OutriderRuntime {
	switchModel(model: ModelRef): Promise<boolean>;
	appendHiddenInstruction(content: string): Promise<void> | void;
	notify(message: string, level: "info" | "warning" | "error"): void;
}

export const DEFAULT_IGNORED_PATHS = [".git/**", ".pi/**", "tmp/**", "temp/**", "*.md", "TODO", "TODO.*"];

/** customType of the guide-instruction message in plan mode; opens a prunable segment. */
export const GUIDE_MARKER = "outrider:guide";
/** customType of the handoff message in plan mode; closes a prunable segment. */
export const HANDOFF_MARKER = "outrider:handoff";
/** customType of all Outrider messages in trajectory mode (pre-0.4 behavior, never pruned). */
export const TRAJECTORY_MARKER = "outrider";

export const GUIDE_INSTRUCTION = `You are currently the guide model in a Outrider session.

Explore the relevant repository areas deeply enough to establish the correct
implementation direction. Reuse existing project conventions and inspect
relevant tests, types, callers, and configuration.

Maintain a bounded implementation checklist when useful.

Once the direction is sufficiently established, call the
outrider_direction_ready tool. Then perform the first meaningful code
modification yourself.

Do not stop immediately after signalling readiness. The runtime will perform
the model handoff only after a successful meaningful modification.

Until the runtime confirms the handoff, continue working normally.`;

export const EXECUTOR_INSTRUCTION = `You are now the executor model in an active Outrider session.

Continue from the existing session trajectory. The guide model has already
explored the relevant code, established the implementation direction, and
completed the first meaningful modification.

Use the existing findings, tool results, checklist, and working-tree state.
Do not restart repository exploration unless new evidence requires it.

Finish the implementation, run the relevant tests and checks, fix failures,
and verify that the task is complete.`;

export const GUIDE_INSTRUCTION_PLAN = `You are the guide model in an Outrider session using plan handoff.

Explore the relevant repository areas deeply enough to establish the
complete implementation direction. Reuse existing project conventions and
inspect relevant tests, types, callers, and configuration.

A cheaper executor model will finish the work, and it will NOT see your
exploration: only your written plan survives the handoff. Every insight you
do not write down is lost.

When the direction is established, call the outrider_direction_ready tool
with a plan that stands on its own. It must cover:

- Goal: what the task must achieve, concretely.
- Current state: the relevant files and how they work today.
- Key insights: every non-obvious constraint, invariant, or trap you found.
- Steps: an ordered implementation checklist with file paths.
- Verification: the exact commands and tests that must pass.

Then perform the first meaningful code modification yourself. The runtime
performs the handoff only after a successful meaningful modification. Until
the runtime confirms the handoff, continue working normally.`;

export const EXECUTOR_INSTRUCTION_PLAN = `You are now the executor model in an active Outrider session using plan handoff.

The guide model explored the repository, established the implementation
direction, and wrote the handoff plan below. The guide's exploration is not
part of your context: your starting points are the task messages above, the
plan, and the current working tree.

Re-read the specification and any file you need directly. Treat the plan as
the map and the repository as the authority. If the project is under version
control, diff the files listed at the end of this message to see the guide's
initial modification.

Follow the plan's steps, finish the implementation, run its verification
commands, fix failures, and confirm the task is complete.`;

export const PLAN_MIN_CHARS = 400;
export const PLAN_MIN_LINES = 8;

/** Returns a rejection reason, or null when the plan clears the minimum bar. */
export function validatePlan(plan: string | undefined): string | null {
	const text = plan?.trim() ?? "";
	if (text.length === 0) {
		return "a plan is required for plan handoff";
	}
	if (text.length < PLAN_MIN_CHARS) {
		return `plan too short (${text.length} chars, need at least ${PLAN_MIN_CHARS}); cover goal, current state, key insights, ordered steps, and verification`;
	}
	const lines = text.split("\n").filter((line) => line.trim() !== "").length;
	if (lines < PLAN_MIN_LINES) {
		return `plan too flat (${lines} non-empty lines, need at least ${PLAN_MIN_LINES}); break it into goal, current state, key insights, ordered steps, and verification`;
	}
	return null;
}

/** The handoff message for plan mode: executor instruction, plan, and guide-touched files. */
export function buildHandoffContent(plan: string, touchedPaths: string[]): string {
	const touched =
		touchedPaths.length > 0
			? `Files already modified by the guide (in the working tree):\n${touchedPaths.map((p) => `- ${p}`).join("\n")}`
			: "The guide has not modified any files yet.";
	return `${EXECUTOR_INSTRUCTION_PLAN}\n\n# Handoff plan\n\n${plan.trim()}\n\n${touched}`;
}

/**
 * Prune closed guide segments from an LLM context. A segment opens at a
 * GUIDE_MARKER custom message and closes at the next HANDOFF_MARKER; inside a
 * closed segment only user messages and foreign custom messages survive (the
 * guide's assistant turns, tool results, and the guide marker itself are
 * dropped). The handoff message and everything after it are kept. A segment
 * without a closing marker, or interrupted by the next guide marker, is left
 * untouched. Pure and non-destructive: callers apply it per request.
 */
export function pruneGuideTrajectory<T extends { role: string }>(messages: T[]): T[] {
	const customType = (m: T): string | undefined =>
		m.role === "custom" ? (m as { customType?: string }).customType : undefined;
	const out: T[] = [];
	let i = 0;
	while (i < messages.length) {
		const msg = messages[i]!;
		if (customType(msg) === GUIDE_MARKER) {
			let end = -1;
			for (let j = i + 1; j < messages.length; j++) {
				const type = customType(messages[j]!);
				if (type === HANDOFF_MARKER) {
					end = j;
					break;
				}
				if (type === GUIDE_MARKER) break;
			}
			if (end !== -1) {
				for (let j = i + 1; j < end; j++) {
					const m = messages[j]!;
					if (m.role === "user") {
						out.push(m);
					} else if (m.role === "custom" && customType(m) !== GUIDE_MARKER && customType(m) !== HANDOFF_MARKER) {
						out.push(m);
					}
				}
				out.push(messages[end]!);
				i = end + 1;
				continue;
			}
		}
		out.push(msg);
		i++;
	}
	return out;
}

export function refName(model: ModelRef): string {
	return `${model.provider}/${model.id}`;
}

export function normalizePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function globToRegExp(glob: string): RegExp {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i]!;
		if (c === "*") {
			if (glob[i + 1] === "*") {
				re += ".*";
				i++;
				if (glob[i + 1] === "/") i++;
			} else {
				re += "[^/]*";
			}
		} else if (c === "?") {
			re += "[^/]";
		} else {
			re += /[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
		}
	}
	return new RegExp(`^${re}$`);
}

/** Gitignore-style matching: patterns containing "/" match the full relative path, others match the basename. */
export function isIgnoredPath(path: string, patterns: string[]): boolean {
	const normalized = normalizePath(path);
	const base = normalized.slice(normalized.lastIndexOf("/") + 1);
	return patterns.some((pattern) => globToRegExp(pattern).test(pattern.includes("/") ? normalized : base));
}

export type ReadySignalResult = "recorded" | "already_recorded" | "not_guiding" | "plan_rejected";

export class OutriderProtocol {
	readonly config: OutriderConfig;
	private readonly runtime: OutriderRuntime;
	private _state: OutriderState = "idle";
	private ready = false;
	private plan: string | undefined;
	private touchedPaths = new Set<string>();

	constructor(config: OutriderConfig, runtime: OutriderRuntime) {
		this.config = config;
		this.runtime = runtime;
	}

	get state(): OutriderState {
		return this._state;
	}

	get directionReady(): boolean {
		return this.ready;
	}

	private reset(state: OutriderState): void {
		this._state = state;
		this.ready = false;
		this.plan = undefined;
		this.touchedPaths.clear();
	}

	/** idle -> armed. Returns false if not idle. */
	arm(): boolean {
		if (this._state !== "idle") return false;
		this.reset("armed");
		return true;
	}

	/** any -> idle. Returns false if already idle. */
	cancel(): boolean {
		if (this._state === "idle") return false;
		this.reset("idle");
		return true;
	}

	/** armed -> guiding. Returns true when the guide instruction should be injected. */
	taskStart(): boolean {
		if (this._state !== "armed") return false;
		this.reset("guiding");
		return true;
	}

	/** In plan mode, readiness is recorded only together with a plan that passes validatePlan. */
	signalDirectionReady(plan?: string): ReadySignalResult {
		if (this._state !== "guiding") return "not_guiding";
		if (this.ready) return "already_recorded";
		if (this.config.handoff === "plan") {
			if (validatePlan(plan) !== null) return "plan_rejected";
			this.plan = plan!.trim();
		}
		this.ready = true;
		return "recorded";
	}

	isMeaningfulPath(path: string): boolean {
		return !isIgnoredPath(path, this.config.ignoredPaths);
	}

	/**
	 * Handoff gate. Only a successful mutation of at least one meaningful path,
	 * after the direction-ready signal, while guiding, triggers the switch.
	 * Every successful meaningful mutation during guiding is tracked so the
	 * plan-mode handoff message can list what the guide already changed.
	 */
	async onMutation(mutation: MutationResult): Promise<void> {
		if (this._state !== "guiding") return;
		if (!mutation.successful) return;
		const meaningful = mutation.paths.filter((p) => this.isMeaningfulPath(p));
		if (meaningful.length === 0) return;
		for (const path of meaningful) this.touchedPaths.add(path);
		if (!this.ready) return;

		// Compare-and-swap: this synchronous transition happens before any await,
		// so concurrent qualifying tool results see handoff_pending and bail above.
		this._state = "handoff_pending";

		let switched = false;
		try {
			switched = await this.runtime.switchModel(this.config.executorModel);
		} catch {
			switched = false;
		}

		if (!switched) {
			// Retry policy: readiness is kept, the next meaningful mutation retries.
			this._state = "guiding";
			this.runtime.notify(`Outrider handoff failed; continuing with ${refName(this.config.guideModel)}`, "warning");
			return;
		}

		this._state = "executing";
		const content =
			this.config.handoff === "plan"
				? buildHandoffContent(this.plan ?? "", [...this.touchedPaths])
				: EXECUTOR_INSTRUCTION;
		await this.runtime.appendHiddenInstruction(content);
		this.runtime.notify(`Outrider handoff: ${refName(this.config.executorModel)} is now active`, "info");
	}

	/** Agent settled: reset to idle, or back to armed when armForNextTaskOnly is false. */
	settled(): "reset" | "rearmed" | "unchanged" {
		if (this._state === "idle" || this._state === "armed") return "unchanged";
		const rearm = !this.config.armForNextTaskOnly;
		this.reset(rearm ? "armed" : "idle");
		return rearm ? "rearmed" : "reset";
	}

	status(): string {
		return (
			`Outrider ${this._state} (${this.config.handoff} handoff)` +
			` | ${refName(this.config.guideModel)} -> ${refName(this.config.executorModel)}` +
			` | direction ready: ${this.ready ? "yes" : "no"}`
		);
	}
}
