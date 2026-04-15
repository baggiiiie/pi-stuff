# pi-stuff

Small monorepo for standalone pi extension packages:

- `packages/context-chart` → `@baggiiiie/pi-context-chart`
- `packages/codex-usage` → `@baggiiiie/pi-codex-usage`
- `packages/rtk-rewrite` → `@baggiiiie/pi-rtk-rewrite`

## Install locally

Install any package directly from this repo:

```bash
pi install ./packages/context-chart
pi install ./packages/codex-usage
pi install ./packages/rtk-rewrite
```

## Publish separately

From each package directory:

```bash
cd packages/context-chart && npm publish --access public
cd packages/codex-usage && npm publish --access public
cd packages/rtk-rewrite && npm publish --access public
```

Or publish all non-private workspace packages from the repo root:

```bash
npm run publish:all
```

## Avoid authenticating for every package publish

This repo is configured to use an npm token from `NPM_TOKEN` via `.npmrc`.
`scripts/publish-all.sh` also auto-loads `.env` from the repo root.

1. Create an npm token with publish access.
2. Put it in `.env`:

```bash
echo 'NPM_TOKEN=xxxxxxxxxxxxxxxx' > .env
```

3. Verify auth and publish:

```bash
npm whoami
npm run publish:all
```

If `NPM_TOKEN` is not set, `scripts/publish-all.sh` will warn that npm may prompt for auth or 2FA once per package.

Then users can install them independently:

```bash
pi install npm:@baggiiiie/pi-context-chart
pi install npm:@baggiiiie/pi-codex-usage
pi install npm:@baggiiiie/pi-rtk-rewrite
```

## Local development in this repo

Project-local pi loaders live here:

- `.pi/extensions/context-chart.ts`
- `.pi/extensions/codex-usage.ts`
- `.pi/extensions/rtk-rewrite.ts`

They point at the package sources so `/reload` keeps working while developing in this repo.
