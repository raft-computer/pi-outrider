/**
 * Portable Outrider core: protocol state machine, handoff gate, and
 * mutation policy. Runtime independent, no pi imports.
 *
 * State machine:
 *   idle -> armed -> guiding -> handoff_pending -> executing -> idle
 *   handoff_pending falls back to guiding when the model switch fails.
 */

export type OutriderState = "idle" | "armed" | "guiding" | "handoff_pending" | "executing";

export interface ModelRef {
	provider: string;
	id: string;
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
}

export interface OutriderRuntime {
	switchModel(model: ModelRef): Promise<boolean>;
	appendHiddenInstruction(content: string): Promise<void> | void;
	notify(message: string, level: "info" | "warning" | "error"): void;
}

export const DEFAULT_IGNORED_PATHS = [".git/**", ".pi/**", "tmp/**", "temp/**", "*.md", "TODO", "TODO.*"];

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

export class OutriderProtocol {
	readonly config: OutriderConfig;
	private readonly runtime: OutriderRuntime;
	private _state: OutriderState = "idle";
	private ready = false;

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

	/** idle -> armed. Returns false if not idle. */
	arm(): boolean {
		if (this._state !== "idle") return false;
		this._state = "armed";
		this.ready = false;
		return true;
	}

	/** any -> idle. Returns false if already idle. */
	cancel(): boolean {
		if (this._state === "idle") return false;
		this._state = "idle";
		this.ready = false;
		return true;
	}

	/** armed -> guiding. Returns true when the guide instruction should be injected. */
	taskStart(): boolean {
		if (this._state !== "armed") return false;
		this._state = "guiding";
		this.ready = false;
		return true;
	}

	signalDirectionReady(): "recorded" | "already_recorded" | "not_guiding" {
		if (this._state !== "guiding") return "not_guiding";
		if (this.ready) return "already_recorded";
		this.ready = true;
		return "recorded";
	}

	isMeaningfulPath(path: string): boolean {
		return !isIgnoredPath(path, this.config.ignoredPaths);
	}

	/**
	 * Handoff gate. Only a successful mutation of at least one meaningful path,
	 * after the direction-ready signal, while guiding, triggers the switch.
	 */
	async onMutation(mutation: MutationResult): Promise<void> {
		if (this._state !== "guiding" || !this.ready) return;
		if (!mutation.successful) return;
		if (!mutation.paths.some((p) => this.isMeaningfulPath(p))) return;

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
		await this.runtime.appendHiddenInstruction(EXECUTOR_INSTRUCTION);
		this.runtime.notify(`Outrider handoff: ${refName(this.config.executorModel)} is now active`, "info");
	}

	/** Agent settled: reset to idle, or back to armed when armForNextTaskOnly is false. */
	settled(): "reset" | "rearmed" | "unchanged" {
		if (this._state === "idle" || this._state === "armed") return "unchanged";
		this.ready = false;
		if (this.config.armForNextTaskOnly) {
			this._state = "idle";
			return "reset";
		}
		this._state = "armed";
		return "rearmed";
	}

	status(): string {
		return (
			`Outrider ${this._state} | ${refName(this.config.guideModel)} -> ${refName(this.config.executorModel)}` +
			` | direction ready: ${this.ready ? "yes" : "no"}`
		);
	}
}
