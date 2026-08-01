/**
 * Outrider pi adapter: a strong guide model starts the task, explores, signals
 * direction readiness, and makes the first meaningful modification. The
 * runtime then switches to a cheaper executor model in the same session, which
 * inherits the full trajectory and finishes the work.
 *
 * Commands: /outrider, /outrider status, /outrider cancel
 * Config:   .pi/outrider.json in the project, else ~/.pi/agent/outrider.json
 *           (the global one is created on first /outrider)
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isEditToolResult, isWriteToolResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	DEFAULT_IGNORED_PATHS,
	GUIDE_INSTRUCTION,
	type ModelRef,
	type OutriderConfig,
	OutriderProtocol,
	refName,
} from "./core.ts";

// ponytail: mirrors pi's own agent-dir derivation; a custom piConfig.configDir
// install would need the real config API if pi ever exposes it to extensions.
const GLOBAL_CONFIG_PATH = join(homedir(), ".pi", "agent", "outrider.json");

/** Project config (`.pi/outrider.json` in the working directory) wins over the global one. */
function resolveConfigPath(cwd: string): string {
	const project = join(cwd, ".pi", "outrider.json");
	return existsSync(project) ? project : GLOBAL_CONFIG_PATH;
}

const CONFIG_TEMPLATE: OutriderConfig = {
	guideModel: { provider: "PROVIDER", id: "STRONG_MODEL_ID" },
	executorModel: { provider: "PROVIDER", id: "CHEAP_MODEL_ID" },
	ignoredPaths: DEFAULT_IGNORED_PATHS,
	armForNextTaskOnly: true,
};

function loadConfig(path: string): OutriderConfig | string {
	if (!existsSync(path)) {
		writeFileSync(path, `${JSON.stringify(CONFIG_TEMPLATE, null, "\t")}\n`);
		return `Outrider: created ${path}. Set guideModel and executorModel, then run /outrider again. Per-project config: .pi/outrider.json.`;
	}
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (err) {
		return `Outrider: invalid JSON in ${path}: ${err instanceof Error ? err.message : String(err)}`;
	}
	const cfg = raw as Partial<OutriderConfig>;
	for (const key of ["guideModel", "executorModel"] as const) {
		const ref = cfg[key];
		if (!ref || typeof ref.provider !== "string" || typeof ref.id !== "string" || !ref.provider || !ref.id) {
			return `Outrider: ${key} in ${path} must be { "provider": "...", "id": "..." }`;
		}
		if (ref.thinking !== undefined && !["minimal", "low", "medium", "high", "xhigh", "max"].includes(ref.thinking)) {
			return `Outrider: ${key}.thinking in ${path} must be one of minimal|low|medium|high|xhigh|max`;
		}
	}
	return {
		guideModel: cfg.guideModel as ModelRef,
		executorModel: cfg.executorModel as ModelRef,
		ignoredPaths: Array.isArray(cfg.ignoredPaths) ? cfg.ignoredPaths.map(String) : DEFAULT_IGNORED_PATHS,
		armForNextTaskOnly: cfg.armForNextTaskOnly !== false,
	};
}

export default function (pi: ExtensionAPI) {
	// Protocol state is in-memory only: a reload, /new, /resume, or /fork
	// rebinds the extension and starts back at idle.
	let core: OutriderProtocol | undefined;
	let lastCtx: ExtensionContext | undefined;
	const resolved = new Map<string, Model<Api>>();

	const notify = (message: string, level: "info" | "warning" | "error") => {
		if (lastCtx?.hasUI) lastCtx.ui.notify(message, level);
	};

	// Session thinking level before Outrider first touched it; phases without
	// an explicit `thinking` fall back to this instead of inheriting the
	// previous phase's level.
	let sessionThinking: ReturnType<ExtensionAPI["getThinkingLevel"]> | undefined;

	const applyThinking = (ref: ModelRef) => {
		sessionThinking ??= pi.getThinkingLevel();
		pi.setThinkingLevel(ref.thinking ?? sessionThinking);
	};

	pi.registerCommand("outrider", {
		description: "Arm Outrider guide-to-executor handoff (status | cancel)",
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const arg = args.trim();

			if (arg === "status") {
				ctx.ui.notify(core?.status() ?? "Outrider idle (not armed)", "info");
				return;
			}
			if (arg === "cancel") {
				ctx.ui.notify(core?.cancel() ? "Outrider cancelled" : "Outrider is not active", "info");
				return;
			}
			if (arg !== "") {
				ctx.ui.notify("Usage: /outrider [status|cancel]", "warning");
				return;
			}

			if (core && core.state !== "idle") {
				ctx.ui.notify(`Outrider already active (${core.state}). Use /outrider cancel first.`, "warning");
				return;
			}

			const configPath = resolveConfigPath(ctx.cwd);
			const config = loadConfig(configPath);
			if (typeof config === "string") {
				ctx.ui.notify(config, "error");
				return;
			}

			const guide = ctx.modelRegistry.find(config.guideModel.provider, config.guideModel.id);
			const executor = ctx.modelRegistry.find(config.executorModel.provider, config.executorModel.id);
			for (const [ref, model] of [
				[config.guideModel, guide],
				[config.executorModel, executor],
			] as const) {
				if (!model) {
					ctx.ui.notify(`Outrider: model ${refName(ref)} not found. Check ${configPath}.`, "error");
					return;
				}
				if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
					ctx.ui.notify(`Outrider: no configured auth for ${refName(ref)}.`, "error");
					return;
				}
			}
			resolved.set(refName(config.guideModel), guide!);
			resolved.set(refName(config.executorModel), executor!);

			if (!(await pi.setModel(guide!))) {
				ctx.ui.notify(`Outrider: failed to switch to guide model ${refName(config.guideModel)}. Not armed.`, "error");
				return;
			}
			applyThinking(config.guideModel);

			core = new OutriderProtocol(config, {
				switchModel: async (ref) => {
					const model = resolved.get(refName(ref));
					if (!model || !(await pi.setModel(model))) return false;
					applyThinking(ref);
					return true;
				},
				appendHiddenInstruction: (content) => {
					pi.sendMessage({ customType: "outrider", content, display: false }, { deliverAs: "steer" });
				},
				notify,
			});
			core.arm();
			ctx.ui.notify(`Outrider armed: ${refName(config.guideModel)} -> ${refName(config.executorModel)}`, "info");
		},
	});

	pi.registerTool({
		name: "outrider_direction_ready",
		label: "Outrider Direction Ready",
		description:
			"Signal that the implementation direction is established in an active Outrider guide phase. " +
			"Call it once, then perform the first meaningful code modification yourself.",
		parameters: Type.Object({
			direction: Type.Optional(Type.String({ description: "One-line summary of the chosen implementation direction" })),
		}),
		async execute(_toolCallId, _params) {
			switch (core?.signalDirectionReady() ?? "not_guiding") {
				case "recorded":
					notify("Outrider: direction ready", "info");
					return {
						content: [
							{
								type: "text",
								text: "Direction recorded. Now perform the first meaningful code modification; the runtime hands off to the executor model after it succeeds.",
							},
						],
						details: {},
					};
				case "already_recorded":
					return { content: [{ type: "text", text: "Direction was already recorded. Continue working." }], details: {} };
				default:
					return { content: [{ type: "text", text: "No active Outrider guide phase; signal ignored." }], details: {} };
			}
		},
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		lastCtx = ctx;
		if (!core?.taskStart()) return;
		return { message: { customType: "outrider", content: GUIDE_INSTRUCTION, display: false } };
	});

	pi.on("tool_result", async (event, ctx) => {
		lastCtx = ctx;
		if (core?.state !== "guiding") return;
		if (!isEditToolResult(event) && !isWriteToolResult(event)) return;
		const inputPath = (event.input as { path?: unknown }).path;
		if (typeof inputPath !== "string" || inputPath === "") return;
		const raw = inputPath.replace(/^@/, "");
		const abs = isAbsolute(raw) ? raw : resolve(ctx.cwd, raw);
		const rel = relative(ctx.cwd, abs);
		await core.onMutation({
			successful: !event.isError,
			paths: [rel.startsWith("..") ? abs : rel],
		});
	});

	pi.on("agent_settled", async (_event, ctx) => {
		lastCtx = ctx;
		if (!core) return;
		const before = core.state;
		const outcome = core.settled();
		if (outcome === "unchanged") return;
		const ending = before === "executing" ? "task settled" : "task settled before handoff";
		ctx.ui.notify(`Outrider: ${ending}, ${outcome === "rearmed" ? "re-armed for the next task" : "protocol reset"}`, "info");
		if (outcome === "rearmed") {
			const guide = resolved.get(refName(core.config.guideModel));
			if (!guide || !(await pi.setModel(guide))) {
				ctx.ui.notify("Outrider: failed to switch back to the guide model", "error");
			} else {
				applyThinking(core.config.guideModel);
			}
		}
	});
}
