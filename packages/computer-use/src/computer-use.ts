import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { registerComputerUseMacosTools } from "./tools.ts";

export default function (pi: ExtensionAPI): void {
    registerComputerUseMacosTools(pi);
}
