# pi-stuff

Small monorepo for two standalone pi extension packages:

- `packages/context-chart` → `@baggiiiie/pi-context-chart`
- `packages/codex-usage` → `@baggiiiie/pi-codex-usage`

## Install locally

Install either package directly from this repo:

```bash
pi install ./packages/context-chart
pi install ./packages/codex-usage
```

## Publish separately

From each package directory:

```bash
cd packages/context-chart && npm publish --access public
cd packages/codex-usage && npm publish --access public
```

Or publish all non-private workspace packages from the repo root:

```bash
npm run publish:all
```

Then users can install them independently:

```bash
pi install npm:@baggiiiie/pi-context-chart
pi install npm:@baggiiiie/pi-codex-usage
```

## Local development in this repo

Project-local pi loaders live here:

- `.pi/extensions/context-chart.ts`
- `.pi/extensions/codex-usage.ts`

They point at the package sources so `/reload` keeps working while developing in this repo.
