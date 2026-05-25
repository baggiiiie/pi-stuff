/**
 * System Notification Extension
 *
 * Sends a native Ghostty notification (via OSC 777) when the agent finishes working.
 * Detects tmux and writes to the outer client tty so the notification
 * reaches the terminal emulator directly.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";

function getClientTty(): string {
  if (process.env.TMUX) {
    try {
      return execSync("tmux display-message -p '#{client_tty}'", {
        encoding: "utf-8",
      }).trim();
    } catch {}
  }
  return "/dev/tty";
}

function notify(title: string, body: string): void {
  const target = getClientTty();
  try {
    execSync(
      `printf '\\033]777;notify;${title};${body}\\007' > ${target}`,
    );
  } catch {
    // Silent fail — don't crash if tty isn't available
  }
}

export default function (pi: ExtensionAPI) {
  let turnStart = 0;

  pi.on("agent_start", async () => {
    turnStart = Date.now();
  });

  pi.on("agent_end", async () => {
    // Only notify if the agent worked for more than 3 seconds
    // (skip instant responses to avoid notification spam)
    const elapsed = Date.now() - turnStart;
    if (elapsed < 3000) return;

    const seconds = Math.round(elapsed / 1000);
    notify("Pi", `Done (${seconds}s) — ready for input`);
  });
}
