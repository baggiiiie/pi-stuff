# pi-lazy-load

Lightweight Pi extension that registers stub slash commands and loads optional extensions on demand.

## How it works

On startup, the extension reads `lazy-extensions.json` and `settings.json` from `~/.pi/agent`, normalizing entries into command/path pairs. It registers each command as a stub that, when invoked for the first time, dynamically imports the extension's module, calls its exported `install(pi)` (or `default`) function, and marks it loaded. Subsequent invocations are no-ops. Use `/lazy:list` to check which stubs are loaded.

## Configuration

Add lazy extensions in `~/.pi/agent/settings.json`:

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

Paths are resolved relative to `~/.pi/agent` unless absolute or `~/...`.

Use `/lazy:list` to see configured entries.
