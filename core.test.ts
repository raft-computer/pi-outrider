import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildHandoffContent,
	DEFAULT_IGNORED_PATHS,
	EXECUTOR_INSTRUCTION,
	EXECUTOR_INSTRUCTION_PLAN,
	GUIDE_MARKER,
	HANDOFF_MARKER,
	isIgnoredPath,
	type ModelRef,
	type OutriderConfig,
	OutriderProtocol,
	type OutriderRuntime,
	PLAN_MIN_CHARS,
	PLAN_MIN_LINES,
	pruneGuideTrajectory,
	validatePlan,
} from "./core.ts";

class FakeRuntime implements OutriderRuntime {
	switched: ModelRef[] = [];
	instructions: string[] = [];
	notices: [string, string][] = [];
	switchResult: Promise<boolean> | boolean = true;

	async switchModel(model: ModelRef): Promise<boolean> {
		this.switched.push(model);
		return this.switchResult;
	}
	async appendHiddenInstruction(content: string): Promise<void> {
		this.instructions.push(content);
	}
	notify(message: string, level: string): void {
		this.notices.push([message, level]);
	}
}

const config = (overrides: Partial<OutriderConfig> = {}): OutriderConfig => ({
	guideModel: { provider: "p", id: "guide" },
	executorModel: { provider: "p", id: "executor" },
	ignoredPaths: DEFAULT_IGNORED_PATHS,
	armForNextTaskOnly: true,
	handoff: "trajectory",
	...overrides,
});

const VALID_PLAN = [
	"# Goal",
	"Implement the widget cache invalidation described in the task.",
	"# Current state",
	"src/cache.ts holds the cache; src/widgets.ts writes without invalidating.",
	"# Key insights",
	"Invalidation must happen before the write is acknowledged, or readers see stale data.",
	"# Steps",
	"1. Add invalidate() to src/cache.ts.",
	"2. Call it from src/widgets.ts before acknowledging.",
	"# Verification",
	"npm test must pass, including the new cache invalidation test.",
].join("\n");

function guiding(overrides: Partial<OutriderConfig> = {}) {
	const runtime = new FakeRuntime();
	const core = new OutriderProtocol(config(overrides), runtime);
	core.arm();
	core.taskStart();
	return { core, runtime };
}

test("idle -> armed -> guiding", () => {
	const core = new OutriderProtocol(config(), new FakeRuntime());
	assert.equal(core.state, "idle");
	assert.equal(core.taskStart(), false);
	assert.equal(core.arm(), true);
	assert.equal(core.state, "armed");
	assert.equal(core.arm(), false);
	assert.equal(core.taskStart(), true);
	assert.equal(core.state, "guiding");
});

test("ready signal alone does not switch", () => {
	const { core, runtime } = guiding();
	assert.equal(core.signalDirectionReady(), "recorded");
	assert.equal(core.signalDirectionReady(), "already_recorded");
	assert.equal(core.state, "guiding");
	assert.equal(runtime.switched.length, 0);
});

test("mutation before ready does not switch, and not retroactively", async () => {
	const { core, runtime } = guiding();
	await core.onMutation({ successful: true, paths: ["src/app.ts"] });
	assert.equal(runtime.switched.length, 0);
	core.signalDirectionReady();
	assert.equal(core.state, "guiding");
	assert.equal(runtime.switched.length, 0);
});

test("ignored-file mutation does not switch", async () => {
	const { core, runtime } = guiding();
	core.signalDirectionReady();
	for (const path of ["README.md", "docs/notes.md", "TODO", "TODO.txt", ".git/config", ".pi/state.json", "tmp/x.ts"]) {
		await core.onMutation({ successful: true, paths: [path] });
	}
	assert.equal(core.state, "guiding");
	assert.equal(runtime.switched.length, 0);
});

test("failed mutation does not switch", async () => {
	const { core, runtime } = guiding();
	core.signalDirectionReady();
	await core.onMutation({ successful: false, paths: ["src/app.ts"] });
	assert.equal(core.state, "guiding");
	assert.equal(runtime.switched.length, 0);
});

test("ready then meaningful mutation switches", async () => {
	const { core, runtime } = guiding({ executorModel: { provider: "p", id: "executor", thinking: "low" } });
	core.signalDirectionReady();
	await core.onMutation({ successful: true, paths: ["src/app.test.ts"] });
	assert.equal(core.state, "executing");
	assert.deepEqual(runtime.switched, [{ provider: "p", id: "executor", thinking: "low" }]);
});

test("parallel qualifying tool results switch only once", async () => {
	const { core, runtime } = guiding();
	core.signalDirectionReady();
	let release!: (ok: boolean) => void;
	runtime.switchResult = new Promise((r) => {
		release = r;
	});
	const first = core.onMutation({ successful: true, paths: ["a.ts"] });
	const second = core.onMutation({ successful: true, paths: ["b.ts"] });
	release(true);
	await Promise.all([first, second]);
	assert.equal(runtime.switched.length, 1);
	assert.equal(core.state, "executing");
	assert.equal(runtime.instructions.length, 1);
});

test("failed executor switch returns to guiding and can retry", async () => {
	const { core, runtime } = guiding();
	core.signalDirectionReady();
	runtime.switchResult = false;
	await core.onMutation({ successful: true, paths: ["src/app.ts"] });
	assert.equal(core.state, "guiding");
	assert.equal(runtime.instructions.length, 0);
	assert.ok(runtime.notices.some(([m, l]) => m.includes("handoff failed") && l === "warning"));

	runtime.switchResult = true;
	await core.onMutation({ successful: true, paths: ["src/app.ts"] });
	assert.equal(core.state, "executing");
});

test("switchModel throwing returns to guiding", async () => {
	const { core, runtime } = guiding();
	core.signalDirectionReady();
	runtime.switchModel = async () => {
		throw new Error("boom");
	};
	await core.onMutation({ successful: true, paths: ["src/app.ts"] });
	assert.equal(core.state, "guiding");
	assert.equal(runtime.instructions.length, 0);
});

test("successful switch appends the executor instruction once", async () => {
	const { core, runtime } = guiding();
	core.signalDirectionReady();
	await core.onMutation({ successful: true, paths: ["src/app.ts"] });
	await core.onMutation({ successful: true, paths: ["src/other.ts"] });
	assert.deepEqual(runtime.instructions, [EXECUTOR_INSTRUCTION]);
});

test("session settlement resets state", async () => {
	const { core } = guiding();
	core.signalDirectionReady();
	assert.equal(core.settled(), "reset");
	assert.equal(core.state, "idle");
	assert.equal(core.directionReady, false);
});

test("settlement with armForNextTaskOnly false re-arms", async () => {
	const { core, runtime } = guiding({ armForNextTaskOnly: false });
	core.signalDirectionReady();
	await core.onMutation({ successful: true, paths: ["src/app.ts"] });
	assert.equal(core.state, "executing");
	assert.equal(core.settled(), "rearmed");
	assert.equal(core.state, "armed");
	assert.equal(runtime.switched.length, 1);
});

test("cancel resets state", () => {
	const { core } = guiding();
	core.signalDirectionReady();
	assert.equal(core.cancel(), true);
	assert.equal(core.state, "idle");
	assert.equal(core.cancel(), false);
});

test("a second task does not inherit stale readiness or handoff state", async () => {
	const { core, runtime } = guiding({ armForNextTaskOnly: false });
	core.signalDirectionReady();
	await core.onMutation({ successful: true, paths: ["src/app.ts"] });
	assert.equal(core.state, "executing");
	core.settled();
	assert.equal(core.taskStart(), true);
	assert.equal(core.directionReady, false);
	await core.onMutation({ successful: true, paths: ["src/app.ts"] });
	assert.equal(core.state, "guiding");
	assert.equal(runtime.switched.length, 1);
});

test("plan validation boundaries", () => {
	assert.ok(validatePlan(undefined));
	assert.ok(validatePlan(""));
	assert.ok(validatePlan("   \n  "));
	assert.ok(validatePlan("short plan")); // below PLAN_MIN_CHARS
	const flat = "x".repeat(PLAN_MIN_CHARS + 50); // long enough but one line
	assert.ok(validatePlan(flat));
	const enough = Array.from({ length: PLAN_MIN_LINES }, (_, i) => `step ${i}: ${"y".repeat(60)}`).join("\n");
	assert.equal(validatePlan(enough), null);
	assert.equal(validatePlan(VALID_PLAN), null);
});

test("plan mode rejects readiness without a valid plan", async () => {
	const { core, runtime } = guiding({ handoff: "plan" });
	assert.equal(core.signalDirectionReady(), "plan_rejected");
	assert.equal(core.signalDirectionReady("too thin"), "plan_rejected");
	assert.equal(core.directionReady, false);
	await core.onMutation({ successful: true, paths: ["src/app.ts"] });
	assert.equal(core.state, "guiding");
	assert.equal(runtime.switched.length, 0);
});

test("plan mode records readiness with a valid plan and hands off", async () => {
	const { core, runtime } = guiding({ handoff: "plan" });
	assert.equal(core.signalDirectionReady(VALID_PLAN), "recorded");
	assert.equal(core.signalDirectionReady(VALID_PLAN), "already_recorded");
	await core.onMutation({ successful: true, paths: ["src/app.ts"] });
	assert.equal(core.state, "executing");
	assert.equal(runtime.instructions.length, 1);
});

test("plan-mode handoff message carries the plan and all guide-touched paths", async () => {
	const { core, runtime } = guiding({ handoff: "plan" });
	await core.onMutation({ successful: true, paths: ["src/early.ts"] }); // before ready: tracked, no switch
	await core.onMutation({ successful: false, paths: ["src/failed.ts"] }); // failed: not tracked
	await core.onMutation({ successful: true, paths: ["README.md"] }); // ignored: not tracked
	core.signalDirectionReady(VALID_PLAN);
	await core.onMutation({ successful: true, paths: ["src/app.ts"] });
	assert.equal(core.state, "executing");
	const message = runtime.instructions[0]!;
	assert.equal(message, buildHandoffContent(VALID_PLAN, ["src/early.ts", "src/app.ts"]));
	assert.ok(message.startsWith(EXECUTOR_INSTRUCTION_PLAN));
	assert.ok(message.includes(VALID_PLAN));
	assert.ok(message.includes("- src/early.ts"));
	assert.ok(message.includes("- src/app.ts"));
	assert.ok(!message.includes("src/failed.ts"));
	assert.ok(!message.includes("README.md"));
});

test("trajectory mode ignores the plan argument and keeps the v1 instruction", async () => {
	const { core, runtime } = guiding();
	assert.equal(core.signalDirectionReady(VALID_PLAN), "recorded");
	await core.onMutation({ successful: true, paths: ["src/app.ts"] });
	assert.deepEqual(runtime.instructions, [EXECUTOR_INSTRUCTION]);
});

test("plan and touched paths do not leak into the next guided task", async () => {
	const { core, runtime } = guiding({ handoff: "plan", armForNextTaskOnly: false });
	await core.onMutation({ successful: true, paths: ["src/first.ts"] });
	core.signalDirectionReady(VALID_PLAN);
	await core.onMutation({ successful: true, paths: ["src/app.ts"] });
	assert.equal(core.settled(), "rearmed");
	assert.equal(core.taskStart(), true);
	assert.equal(core.signalDirectionReady(), "plan_rejected"); // stale plan gone
	core.signalDirectionReady(VALID_PLAN);
	await core.onMutation({ successful: true, paths: ["src/second.ts"] });
	const second = runtime.instructions[1]!;
	assert.ok(second.includes("- src/second.ts"));
	assert.ok(!second.includes("src/first.ts"));
	assert.ok(!second.includes("src/app.ts"));
});

type Msg = { role: string; customType?: string; id: number };
let msgId = 0;
const msg = (role: string, customType?: string): Msg => ({
	role,
	...(customType === undefined ? {} : { customType }),
	id: msgId++,
});
const ids = (messages: Msg[]) => messages.map((m) => m.id);

test("prune: context without markers is unchanged", () => {
	const messages = [msg("user"), msg("assistant"), msg("toolResult"), msg("custom", "other-ext")];
	assert.deepEqual(ids(pruneGuideTrajectory(messages)), ids(messages));
});

test("prune: an open guide segment is left untouched", () => {
	const messages = [msg("user"), msg("custom", GUIDE_MARKER), msg("assistant"), msg("toolResult")];
	assert.deepEqual(ids(pruneGuideTrajectory(messages)), ids(messages));
});

test("prune: a closed segment keeps user and foreign custom messages only", () => {
	const before = msg("user");
	const guide = msg("custom", GUIDE_MARKER);
	const explore1 = msg("assistant");
	const explore2 = msg("toolResult");
	const steer = msg("user");
	const foreign = msg("custom", "other-ext");
	const handoff = msg("custom", HANDOFF_MARKER);
	const execWork1 = msg("assistant");
	const execWork2 = msg("toolResult");
	const pruned = pruneGuideTrajectory([before, guide, explore1, explore2, steer, foreign, handoff, execWork1, execWork2]);
	assert.deepEqual(ids(pruned), ids([before, steer, foreign, handoff, execWork1, execWork2]));
});

test("prune: an unclosed segment followed by a closed one prunes only the closed one", () => {
	const task1 = msg("user");
	const guide1 = msg("custom", GUIDE_MARKER);
	const work1 = msg("assistant"); // task settled while guiding: no handoff marker
	const task2 = msg("user");
	const guide2 = msg("custom", GUIDE_MARKER);
	const work2 = msg("assistant");
	const handoff2 = msg("custom", HANDOFF_MARKER);
	const tail = msg("assistant");
	const pruned = pruneGuideTrajectory([task1, guide1, work1, task2, guide2, work2, handoff2, tail]);
	assert.deepEqual(ids(pruned), ids([task1, guide1, work1, task2, handoff2, tail]));
});

test("prune: multiple closed segments are all pruned", () => {
	const task1 = msg("user");
	const guide1 = msg("custom", GUIDE_MARKER);
	const explore1 = msg("assistant");
	const handoff1 = msg("custom", HANDOFF_MARKER);
	const exec1 = msg("assistant");
	const task2 = msg("user");
	const guide2 = msg("custom", GUIDE_MARKER);
	const explore2 = msg("toolResult");
	const handoff2 = msg("custom", HANDOFF_MARKER);
	const exec2 = msg("assistant");
	const pruned = pruneGuideTrajectory([
		task1,
		guide1,
		explore1,
		handoff1,
		exec1,
		task2,
		guide2,
		explore2,
		handoff2,
		exec2,
	]);
	assert.deepEqual(ids(pruned), ids([task1, handoff1, exec1, task2, handoff2, exec2]));
});

test("mutation policy path matching", () => {
	const patterns = DEFAULT_IGNORED_PATHS;
	assert.equal(isIgnoredPath("README.md", patterns), true);
	assert.equal(isIgnoredPath("docs/deep/notes.md", patterns), true);
	assert.equal(isIgnoredPath(".git/hooks/pre-commit", patterns), true);
	assert.equal(isIgnoredPath("tmp/scratch.ts", patterns), true);
	assert.equal(isIgnoredPath("TODO", patterns), true);
	assert.equal(isIgnoredPath("TODO.md", patterns), true);
	assert.equal(isIgnoredPath("./src/TODO.ts", patterns), true);
	assert.equal(isIgnoredPath("src/app.ts", patterns), false);
	assert.equal(isIgnoredPath("config/settings.yaml", patterns), false);
	assert.equal(isIgnoredPath("migrations/001_init.sql", patterns), false);
	assert.equal(isIgnoredPath("package.json", patterns), false);
	assert.equal(isIgnoredPath("mdfile.txt", patterns), false);
	assert.equal(isIgnoredPath("templates/x.ts", patterns), false);
});
