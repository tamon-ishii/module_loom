#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$project_dir"

build=false
case "${1:-}" in
  --help|-h)
    printf '%s\n' '使い方: ./start-manual-studio.sh [--build | --dev]' \
      '  引数なし: ビルド済みのアプリを起動（初回は自動ビルド）' \
      '  --build:  現在のソースからビルドして起動' \
      '  --dev:    変更を反映する開発モードで起動'
    exit 0
    ;;
  --dev)
    command -v npm >/dev/null || { printf '%s\n' 'Node.js/npmをインストールしてください。' >&2; exit 1; }
    [[ -d node_modules ]] || npm ci
    exec npm run manual:app
    ;;
  --build) build=true ;;
  '') ;;
  *) printf '不明なオプション: %s\n' "$1" >&2; exit 2 ;;
esac

target_dir="${CARGO_TARGET_DIR:-$project_dir/target}"
app_binary=""
if [[ "$build" == false ]]; then
  for profile in release debug; do
    if [[ -x "$target_dir/$profile/manual-studio" ]]; then
      app_binary="$target_dir/$profile/manual-studio"
      break
    fi
  done
fi

if [[ -z "$app_binary" ]]; then
  for tool in npm cargo; do
    command -v "$tool" >/dev/null || { printf '初回ビルドには %s が必要です。\n' "$tool" >&2; exit 1; }
  done
  [[ -d node_modules ]] || npm ci
  npm run manual:build
  cargo build --locked -p manual-studio
  app_binary="$target_dir/debug/manual-studio"
fi

exec "$app_binary"
