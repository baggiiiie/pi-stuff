import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isBashToolResult, isToolCallEventType } from "@mariozechner/pi-coding-agent";

const ANSI_ESCAPE_RE = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

const ENV_PREFIX = 'NO_COLOR=1 CLICOLOR=0 FORCE_COLOR=0 TERM=dumb';

export default function noAnsiExtension(pi: ExtensionAPI) {
	pi.on("tool_call", async (event) => {
		if (!isToolCallEventType("bash", event)) return;
		const command = event.input.command;
		if (typeof command !== "string" || !command.trim()) return;
		event.input.command = `${ENV_PREFIX} ${command}`;
	});

	pi.on("tool_result", async (event) => {
		if (!isBashToolResult(event)) return;

		return {
			content: event.content.map((item) => {
				if (item.type !== "text") return item;
				return {
					...item,
					text: sanitizeTerminalText(item.text),
				};
			}),
		};
	});
}

function sanitizeTerminalText(text: string): string {
	return text.replace(ANSI_ESCAPE_RE, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}
