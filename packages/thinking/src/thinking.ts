import {
	ThinkingSelectorComponent,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const STATUS_KEY = "thinking";

export default function thinkingExtension(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		updateStatus(ctx, pi.getThinkingLevel());
	});

	pi.on("thinking_level_select", (event, ctx) => {
		updateStatus(ctx, event.level);
	});

	pi.registerCommand("thinking", {
		description: "Select the current model's thinking level",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify(`Thinking level: ${pi.getThinkingLevel()}`, "info");
				return;
			}

			const levels = getAvailableThinkingLevels(ctx.model);
			await ctx.ui.custom<void>((tui, _theme, _unused, done) => {
				const selector = new ThinkingSelectorComponent(
					pi.getThinkingLevel(),
					levels,
					(level) => {
						pi.setThinkingLevel(level);
						done(undefined);
					},
					() => done(undefined),
				);
				const selectList = selector.getSelectList();

				return {
					render: (width) => selector.render(width),
					invalidate: () => selector.invalidate(),
					handleInput: (data) => {
						selectList.handleInput(data);
						tui.requestRender();
					},
				};
			});
		},
	});
}

function getAvailableThinkingLevels(model: ExtensionContext["model"]): ThinkingLevel[] {
	if (!model) return THINKING_LEVELS;
	if (!model.reasoning) return ["off"];

	return THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		return level !== "xhigh" || mapped !== undefined;
	});
}

function updateStatus(ctx: ExtensionContext, level: ThinkingLevel): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(STATUS_KEY, `Thinking: ${level}`);
}
