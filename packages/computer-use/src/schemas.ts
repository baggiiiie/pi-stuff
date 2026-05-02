import { Type, type Static } from "typebox";

export const ListAppsParams = Type.Object({});

export const GetStateParams = Type.Object({
    app: Type.String({ description: "Bundle id, e.g. com.apple.Notes" }),
});

export const ClickParams = Type.Object({
    app: Type.String({ description: "Bundle id, e.g. com.apple.Notes" }),
    element_index: Type.Optional(
        Type.Integer({
            minimum: 0,
            description: "Index of an element from the most recent get_app_state call. Mutually exclusive with x/y.",
        }),
    ),
    x: Type.Optional(Type.Number({ description: "Absolute screen x in points (top-left origin). Requires y." })),
    y: Type.Optional(Type.Number({ description: "Absolute screen y in points (top-left origin). Requires x." })),
    click_count: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 5, description: "Number of clicks (1=single, 2=double). Default 1." }),
    ),
});

export const SUPPORTED_KEYS = [
    "Right", "Left", "Up", "Down",
    "Enter", "Return", "Escape", "Esc",
    "Tab", "Space", "Delete", "Backspace", "ForwardDelete",
    "Home", "End", "PageUp", "PageDown",
    "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
] as const;

export const PressKeyParams = Type.Object({
    app: Type.String({ description: "Bundle id, e.g. com.apple.Notes" }),
    key: Type.String({
        description: `Key name. One of: ${SUPPORTED_KEYS.join(", ")}.`,
    }),
    modifiers: Type.Optional(
        Type.String({
            description:
                'Optional modifier keys, comma- or "+"-separated. Any of: command, shift, option, control. Example: "command+shift".',
        }),
    ),
});

export const TypeTextParams = Type.Object({
    app: Type.String({ description: "Bundle id, e.g. com.apple.Notes" }),
    text: Type.String({ description: "Exact text to insert at the current focus via pasteboard." }),
});

export type ListAppsArgs = Static<typeof ListAppsParams>;
export type GetStateArgs = Static<typeof GetStateParams>;
export type ClickArgs = Static<typeof ClickParams>;
export type PressKeyArgs = Static<typeof PressKeyParams>;
export type TypeTextArgs = Static<typeof TypeTextParams>;
