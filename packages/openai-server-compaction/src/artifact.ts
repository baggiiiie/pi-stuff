import type { Model } from "@earendil-works/pi-ai";

export const ARTIFACT_VERSION = 1;
export const MARKER_PREFIX = "[[PI_OPENAI_SERVER_COMPACTION:";

export interface ServerCompactionArtifact {
  version: 1;
  provider: "openai-codex";
  baseUrl: string;
  model: string;
  api: "openai-codex-responses";
  outputItems: [Record<string, unknown>];
}

export function normalizedBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export function compatibleModel(model: Model<any> | undefined): model is Model<"openai-codex-responses"> {
  return !!model && model.provider === "openai-codex" && model.id.length > 0 &&
    model.api === "openai-codex-responses" && normalizedBaseUrl(model.baseUrl).length > 0;
}

export function validateArtifact(value: unknown): ServerCompactionArtifact | undefined {
  if (!value || typeof value !== "object") return;
  const a = value as Record<string, unknown>;
  const items = a.outputItems;
  if (a.version !== 1 || a.provider !== "openai-codex" || typeof a.model !== "string" || !a.model ||
      a.api !== "openai-codex-responses" || typeof a.baseUrl !== "string" ||
      normalizedBaseUrl(a.baseUrl) !== a.baseUrl || !Array.isArray(items) || items.length !== 1) return;
  const item = items[0];
  if (!item || typeof item !== "object" || (item as any).type !== "compaction" ||
      typeof (item as any).encrypted_content !== "string" || !(item as any).encrypted_content.trim()) return;
  return a as unknown as ServerCompactionArtifact;
}

export function isCompatible(a: ServerCompactionArtifact, model: Model<any>): boolean {
  return compatibleModel(model) && a.model === model.id && a.baseUrl === normalizedBaseUrl(model.baseUrl);
}
