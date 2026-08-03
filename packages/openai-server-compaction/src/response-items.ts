import type { Message, Model } from "@earendil-works/pi-ai";

export function toResponseItems(model: Model<any>, messages: Message[]): unknown[] {
  const items: Record<string, unknown>[] = [];

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const message = messages[messageIndex];
    if (message.role === "user") {
      const content = typeof message.content === "string"
        ? [{ type: "input_text", text: message.content }]
        : message.content.map(item => item.type === "text"
          ? { type: "input_text", text: item.text }
          : { type: "input_image", detail: "auto", image_url: `data:${item.mimeType};base64,${item.data}` });
      if (content.length) items.push({ role: "user", content });
      continue;
    }

    if (message.role === "assistant") {
      let textIndex = 0;
      for (const block of message.content) {
        if (block.type === "thinking" && block.thinkingSignature) {
          try {
            const reasoning = JSON.parse(block.thinkingSignature);
            if (reasoning && typeof reasoning === "object") items.push(reasoning);
          } catch {
            throw new Error("Invalid encrypted Codex reasoning item");
          }
        } else if (block.type === "text") {
          const signature = parseTextSignature(block.textSignature);
          const fallbackId = `msg_pi_${messageIndex}_${textIndex++}`;
          items.push({
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: block.text, annotations: [] }],
            status: "completed",
            id: signature?.id ?? fallbackId,
            ...(signature?.phase ? { phase: signature.phase } : {}),
          });
        } else if (block.type === "toolCall") {
          const separator = block.id.indexOf("|");
          const callId = separator < 0 ? block.id : block.id.slice(0, separator);
          const itemId = separator < 0 ? undefined : block.id.slice(separator + 1);
          items.push({
            type: "function_call",
            ...(itemId ? { id: itemId } : {}),
            call_id: callId,
            name: block.name,
            arguments: JSON.stringify(block.arguments),
          });
        }
      }
      continue;
    }

    const callId = message.toolCallId.split("|")[0];
    const text = message.content.filter(item => item.type === "text").map(item => item.text).join("\n");
    const images = message.content.filter(item => item.type === "image");
    const output = images.length && model.input.includes("image")
      ? [
          ...(text ? [{ type: "input_text", text }] : []),
          ...images.map(item => ({ type: "input_image", detail: "auto", image_url: `data:${item.mimeType};base64,${item.data}` })),
        ]
      : text || (images.length ? "(see attached image)" : "(no tool output)");
    items.push({ type: "function_call_output", call_id: callId, output });
  }

  return repairResponseItems(items);
}

/** Codex rejects orphan outputs and unfinished calls in historical input. */
export function repairResponseItems(items: unknown[]): unknown[] {
  const calls = new Map<string, "function" | "custom">();
  const outputs = new Map<string, "function" | "custom">();
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const callId = typeof item.call_id === "string" ? item.call_id : undefined;
    if (!callId) continue;
    if (item.type === "function_call") calls.set(callId, "function");
    if (item.type === "custom_tool_call") calls.set(callId, "custom");
    if (item.type === "function_call_output") outputs.set(callId, "function");
    if (item.type === "custom_tool_call_output") outputs.set(callId, "custom");
  }

  const result: Record<string, unknown>[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const callId = typeof item.call_id === "string" ? item.call_id : undefined;
    if (item.type === "function_call_output" && (!callId || calls.get(callId) !== "function")) continue;
    if (item.type === "custom_tool_call_output" && (!callId || calls.get(callId) !== "custom")) continue;
    result.push(item);
    const family = item.type === "custom_tool_call" ? "custom" : "function";
    if ((item.type === "function_call" || item.type === "custom_tool_call") && callId && outputs.get(callId) !== family) {
      result.push({
        type: item.type === "custom_tool_call" ? "custom_tool_call_output" : "function_call_output",
        call_id: callId,
        output: "Tool execution was aborted.",
      });
    }
  }
  return result;
}

function parseTextSignature(signature: string | undefined): { id: string; phase?: "commentary" | "final_answer" } | undefined {
  if (!signature) return;
  try {
    const parsed = JSON.parse(signature);
    if (parsed?.v === 1 && typeof parsed.id === "string") {
      const phase = parsed.phase === "commentary" || parsed.phase === "final_answer" ? parsed.phase : undefined;
      return { id: parsed.id, ...(phase ? { phase } : {}) };
    }
  } catch {
    return { id: signature };
  }
  return;
}
