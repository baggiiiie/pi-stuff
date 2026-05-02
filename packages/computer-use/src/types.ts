// Shared types for the macOS computer-use extension.

export interface HelperOk {
    ok: true;
    [key: string]: unknown;
}

export interface HelperErr {
    ok: false;
    error: string;
}

export type HelperResponse = HelperOk | HelperErr;

export interface AppInfo {
    name: string;
    bundleId: string;
    pid: number;
    running: boolean;
}

export interface ListAppsResponse extends HelperOk {
    apps: AppInfo[];
}

export interface Frame {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface UIElement {
    index: number;
    depth: number;
    role: string;
    title: string | null;
    description: string | null;
    identifier: string | null;
    valuePreview: string | null;
    focused: boolean | null;
    selected: boolean | null;
    enabled: boolean | null;
    frame: Frame | null;
    actions: string[];
}

export interface WindowInfo {
    title: string | null;
    frame: Frame | null;
}

export interface AppState extends HelperOk {
    app: string;
    appName: string;
    window: WindowInfo;
    elements: UIElement[];
    screenshotBase64?: string | null;
}

export type ToolContent =
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string };

export interface ToolResult {
    content: ToolContent[];
    details: Record<string, unknown>;
}
