# @baggiiiie/pi-notify

A pi extension that sends a native system notification when the agent finishes working.

Uses the terminal's OSC 777 protocol so the notification appears with your terminal emulator's icon (e.g. Ghostty). Automatically detects tmux and routes the escape sequence to the outer client tty.

## Install

Install from npm:
```bash
pi install npm:@baggiiiie/pi-notify
```

## Usage

Once installed, restart pi or run `/reload`.

No commands or configuration required.

## Notes

- Only notifies when the agent takes 3+ seconds (avoids spam on quick responses)
- Shows elapsed time in the notification body (e.g. "Done (12s) — ready for input")
- Supports tmux: writes to the tmux client tty so the notification reaches the outer terminal
- Tested with Ghostty; should also work with iTerm2, WezTerm, and rxvt-unicode (all support OSC 777)
