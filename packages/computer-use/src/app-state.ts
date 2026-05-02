import { runHelperAs } from "./ipc.ts";
import type { AppState, ToolContent, ToolResult } from "./types.ts";

/**
 * Renders an `AppState` as a human-readable, indented text outline.
 *
 * Produces a header with the app identifier/name and focused window title,
 * followed by one line per accessibility element. Each element line shows its
 * index, role (with the `AX` prefix stripped), state flags (`focused`,
 * `selected`, `disabled`), available actions, and a best-effort label drawn
 * from `title`, `description`, `identifier`, or `valuePreview`. Depth is
 * indented with two spaces per level, capped at 5 levels.
 *
 * @param s - The app state snapshot to format.
 * @returns A multi-line string suitable for display to a human or LLM.
 */
export function formatAppState(s: AppState): string {
    const lines: string[] = [];
    lines.push(`App=${s.app} ${s.appName || ""}`.trim());
    lines.push(`Window: ${JSON.stringify(s.window?.title ?? "")}`);
    lines.push("");
    for (const e of s.elements ?? []) {
        const indent = "  ".repeat(Math.min(e.depth ?? 0, 5));
        const bits: string[] = [`${e.index}`, (e.role || "element").replace(/^AX/, "")];
        if (e.focused) bits.push("focused");
        if (e.selected) bits.push("selected");
        if (e.enabled === false) bits.push("disabled");
        if (e.actions?.length) bits.push(`actions=${e.actions.join(",")}`);
        const label = e.title ?? e.description ?? e.identifier ?? e.valuePreview;
        lines.push(`${indent}${bits.join(" ")}${label ? ` ${JSON.stringify(label)}` : ""}`);
    }
    return lines.join("\n");
}

/**
 * Wraps an `AppState` into a `ToolResult` for the tool-call response.
 *
 * The textual outline from `formatAppState` is placed in the `content` array,
 * and if a screenshot is present it is appended as an image part. The full
 * state (minus the large `screenshotBase64` blob) is returned under
 * `details` so callers can inspect the raw structure without mutating the
 * input.
 *
 * @param s - The app state snapshot to package.
 * @returns A `ToolResult` containing text, optional image, and structured details.
 */
export function appStateToToolResult(s: AppState): ToolResult {
    const text = formatAppState(s);
    const content: ToolContent[] = [{ type: "text", text }];
    if (s.screenshotBase64) {
        content.push({ type: "image", data: s.screenshotBase64, mimeType: "image/png" });
    }
    // Build details without the (large) base64 blob, without mutating input.
    const { screenshotBase64: _omit, ...detailsRest } = s;
    void _omit;
    return { content, details: detailsRest as Record<string, unknown> };
}

/**
 * Fetches the current accessibility state for an app and returns it as a
 * `ToolResult`.
 *
 * Invokes the native helper via IPC with the `get_state` subcommand for the
 * given app identifier, then formats the response through `appStateToToolResult`.
 *
 * @param app - The target app's bundle id or name understood by the helper.
 * @returns A promise resolving to the formatted `ToolResult`.
 */
export async function getAppState(app: string): Promise<ToolResult> {
    const s = await runHelperAs<AppState>(["get_state", app]);
    return appStateToToolResult(s);
}
