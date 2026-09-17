import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installGuardianApprovalExtension } from "./guardian.ts";

export * from "./context.ts";
export * from "./guardian.ts";
export * from "./typesafe-reviewer.ts";

export default function approveForMeExtension(pi: ExtensionAPI): void {
  installGuardianApprovalExtension(pi);
}
