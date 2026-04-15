#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

if [ ! -d packages ]; then
  echo "No packages/ directory found" >&2
  exit 1
fi

EXTRA_ARGS=("$@")
HAS_ACCESS_FLAG=false
for arg in "${EXTRA_ARGS[@]}"; do
  if [ "$arg" = "--access" ]; then
    HAS_ACCESS_FLAG=true
    break
  fi
done
if [ "$HAS_ACCESS_FLAG" = false ]; then
  EXTRA_ARGS=(--access public "${EXTRA_ARGS[@]}")
fi

if [ -n "${NPM_TOKEN:-}" ]; then
  echo "Using NPM_TOKEN for non-interactive npm auth"
else
  cat >&2 <<'EOF'
Warning: NPM_TOKEN is not set.

Without a publish token, npm may ask you to authenticate separately for each package.
To avoid repeated login/2FA prompts, put your npm publish token in .env or export it before running this script:

  echo 'NPM_TOKEN=xxxxxxxxxxxxxxxx' > .env
  npm run publish:all
EOF
  echo >&2
fi

mapfile -t PACKAGE_DIRS < <(find packages -mindepth 1 -maxdepth 1 -type d | sort)

if [ "${#PACKAGE_DIRS[@]}" -eq 0 ]; then
  echo "No package directories found under packages/" >&2
  exit 1
fi

for dir in "${PACKAGE_DIRS[@]}"; do
  pkg_json="$dir/package.json"
  if [ ! -f "$pkg_json" ]; then
    echo "Skipping $dir (no package.json)"
    continue
  fi

  pkg_name="$(node -e 'const fs=require("fs"); const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(p.name||"")' "$pkg_json")"
  pkg_private="$(node -e 'const fs=require("fs"); const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(String(Boolean(p.private)))' "$pkg_json")"

  if [ "$pkg_private" = "true" ]; then
    echo "Skipping $dir ($pkg_name is private)"
    continue
  fi

  echo "==> Publishing $pkg_name from $dir"
  (
    cd "$dir"
    npm publish "${EXTRA_ARGS[@]}"
  )
  echo
 done

echo "Done."
