import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { runHelper, runHelperAs } from "./ipc.ts";
import {
    ClickParams,
    GetStateParams,
    ListAppsParams,
    PressKeyParams,
    TypeTextParams,
    type ClickArgs,
    type GetStateArgs,
    type ListAppsArgs,
    type PressKeyArgs,
    type TypeTextArgs,
} from "./schemas.ts";
import { getAppState } from "./app-state.ts";
import type { ListAppsResponse, ToolResult } from "./types.ts";

export function registerComputerUseMacosTools(pi: ExtensionAPI): void {
    pi.registerTool({
        name: "list_apps",
        label: "List macOS Apps",
        description:
            "List running macOS apps for computer-use automation. Use bundleId as the app parameter for other tools.",
        parameters: ListAppsParams,
        async execute(_id: string, _p: ListAppsArgs): Promise<ToolResult> {
            const r = await runHelperAs<ListAppsResponse>(["list_apps"]);
            const text = r.apps.map((a) => `${a.name} - ${a.bundleId}`).join("\n");
            return {
                content: [{ type: "text", text }],
                details: { apps: r.apps },
            };
        },
    });

    pi.registerTool({
        name: "get_app_state",
        label: "Get macOS App State",
        description:
            "Focus/inspect a macOS app and return a screenshot plus accessibility tree with element indexes.",
        parameters: GetStateParams,
        async execute(_id: string, p: GetStateArgs): Promise<ToolResult> {
            return getAppState(p.app);
        },
    });

    pi.registerTool({
        name: "click",
        label: "Click macOS UI",
        description:
            "Click an accessibility element by element_index from get_app_state, or absolute screen coordinates x/y. Returns updated app state.",
        parameters: ClickParams,
        async execute(_id: string, p: ClickArgs): Promise<ToolResult> {
            const hasElement = p.element_index !== undefined && p.element_index !== null;
            const hasXY = p.x !== undefined && p.y !== undefined;
            if (!hasElement && !hasXY) {
                throw new Error("Provide element_index or both x and y");
            }
            if (hasElement && hasXY) {
                throw new Error("Provide either element_index or x/y, not both");
            }
            const count = String(p.click_count ?? 1);
            if (hasElement) {
                await runHelper(["click", p.app, "element", String(p.element_index), count]);
            } else {
                await runHelper(["click", p.app, "xy", `${p.x},${p.y}`, count]);
            }
            return getAppState(p.app);
        },
    });

    pi.registerTool({
        name: "press_key",
        label: "Press macOS Key",
        description:
            "Press a named key in an app, optionally with modifiers (command/shift/option/control). Returns updated app state.",
        parameters: PressKeyParams,
        async execute(_id: string, p: PressKeyArgs): Promise<ToolResult> {
            const args = ["key", p.app, p.key];
            if (p.modifiers) args.push(p.modifiers);
            await runHelper(args);
            return getAppState(p.app);
        },
    });

    pi.registerTool({
        name: "type_text",
        label: "Type macOS Text",
        description:
            "Type exact text into the currently focused UI element of an app using pasteboard insertion. Returns updated app state.",
        parameters: TypeTextParams,
        async execute(_id: string, p: TypeTextArgs): Promise<ToolResult> {
            await runHelper(["type", p.app, p.text]);
            return getAppState(p.app);
        },
    });
}
