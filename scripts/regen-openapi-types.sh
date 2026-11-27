#!/usr/bin/env bash
# Refresh one Hashpower API schema and its generated TypeScript definitions.
# Usage: scripts/regen-openapi-types.sh [v1|v2]
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root/packages/braiins-client"
case "${1:-v1}" in
  v1) remote_spec=v1.yml; local_spec=openapi.yml; generator=codegen ;;
  v2) remote_spec=v2.json; local_spec=openapi-v2.json; generator=codegen:v2 ;;
  *) echo "usage: $0 [v1|v2]" >&2; exit 2 ;;
esac

download="$(mktemp)"
trap 'rm -f "$download"' EXIT
curl --fail --silent --show-error --location --max-time 30 \
  "https://hashpower.braiins.com/api/openapi/$remote_spec" --output "$download"
cp "$download" "$local_spec"
pnpm run "$generator"
