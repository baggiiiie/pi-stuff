# pi-lazy-load

Lightweight Pi extension that registers stub slash commands and loads optional extensions on demand.

Configure lazy extensions in `~/.pi/agent/settings.json`:

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
