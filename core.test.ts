import assert from "node:assert/strict";
import { test } from "node:test";
import {
	DEFAULT_IGNORED_PATHS,
	EXECUTOR_INSTRUCTION,
	isIgnoredPath,
	type ModelRef,
	type OutriderConfig,
	OutriderProtocol,
	type OutriderRuntime,
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
	...overrides,
});

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
