# pi-lazy-load

Lightweight Pi extension that registers stub slash commands and loads optional extensions on demand.

## Install

Install from npm:
```bash
pi install npm:@baggiiiie/pi-lazy-load
```

## How it works

On startup, the extension reads both `~/.pi/agent/lazy-extensions.json` and `~/.pi/agent/settings.json`, normalizing entries into command/path pairs. It registers each command as a stub that, when invoked for the first time, dynamically imports the extension's module, calls its exported `install(pi)` (or `default`) function, and marks it loaded. Subsequent invocations are no-ops. Use `/lazy:list` to check which stubs are loaded.

## Configuration

Configure lazy extensions in either `~/.pi/agent/lazy-extensions.json` or `~/.pi/agent/settings.json`.

In `settings.json`, use a `lazyExtensions` array:

```json
{
  "lazyExtensions": [
    {
      "command": "autoresearch",
      "description": "Load autoresearch extension",
      "path": "git/github.com/davebcn87/pi-autoresearch/extensions/pi-autoresearch/index.ts"
    }
  ]
}
```

Alternatively, `lazy-extensions.json` may contain the array directly:

```json
[
  {
    "command": "autoresearch",
    "description": "Load autoresearch extension",
    "path": "git/github.com/davebcn87/pi-autoresearch/extensions/pi-autoresearch/index.ts"
  }
]
```

If the same command appears in both files, the `settings.json` entry wins.

Paths are resolved relative to `~/.pi/agent` unless absolute or `~/...`.

Use `/lazy:list` to see configured entries.
