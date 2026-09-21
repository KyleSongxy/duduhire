#!/usr/bin/env bash
# Shared release helpers. Never source a deployment env file as shell code.
set -euo pipefail
umask 077
[[ $- != *x* ]] || { printf 'Disable shell tracing before running operations.\n' >&2; exit 2; }
DUDUHIRE_REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

die() { printf '%s\n' "$1" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "Required command unavailable: $1"; }
immutable_image() {
  [[ $1 =~ ^[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[a-f0-9]{64}$ || $1 =~ ^[a-zA-Z0-9][a-zA-Z0-9./:_-]*:sha-[a-f0-9]{40}$ ]]
}
validate_env_file() {
  [[ $env_file = /* && -f $env_file ]] || die 'Use an absolute path to an existing deployment env file.'
  local mode
  mode=$(stat -c '%a' "$env_file" 2>/dev/null || stat -f '%Lp' "$env_file")
  [[ $mode =~ ^[0-7]{3,4}$ ]] || die 'Cannot verify deployment env permissions.'
  (( (8#$mode & 8#077) == 0 )) || die 'Deployment env must not be readable by group or other users (use chmod 600).'
}
compose() {
  docker compose --env-file "$env_file" -f "$DUDUHIRE_REPO_ROOT/compose.production.yaml" "$@"
}
prepare_release() {
  need docker; need jq
  validate_env_file
  [[ $state_dir = /* && $state_dir != / && $state_dir != "$HOME" ]] || die 'Use a dedicated absolute release-state directory.'
  mkdir -p "$state_dir"
  chmod 700 "$state_dir"
  mkdir "$state_dir/.operation.lock" 2>/dev/null || die 'Another release is running, or an interrupted operation left a lock. Inspect it before retrying.'
  trap 'rmdir "$state_dir/.operation.lock" 2>/dev/null || true' EXIT
  compose config --quiet >/dev/null 2>&1 || die 'Production Compose configuration is invalid. Validate it in a private terminal.'
}
read_config_images() {
  local result
  result=$(compose config --format json 2>/dev/null | jq -er '[.services.api.image, .services.web.image] | @tsv') || die 'Cannot read configured release images.'
  IFS=$'\t' read -r api_image web_image <<< "$result"
  immutable_image "$api_image" && immutable_image "$web_image" || die 'Images must use sha256 digests or full :sha-<40-character commit> tags.'
}
read_release() {
  local release_file=$1
  [[ -f $release_file && ! -L $release_file ]] || die 'A recorded release is required for rollback.'
  api_image=$(sed -n 's/^api=//p' "$release_file")
  web_image=$(sed -n 's/^web=//p' "$release_file")
  immutable_image "$api_image" && immutable_image "$web_image" || die 'Recorded release references are invalid.'
}
write_release() {
  local release_file=$1 temporary
  temporary=$(mktemp "$state_dir/.release.XXXXXX")
  printf 'api=%s\nweb=%s\n' "$api_image" "$web_image" > "$temporary"
  mv "$temporary" "$release_file"
}
use_images() { export DUDUHIRE_API_IMAGE="$api_image" DUDUHIRE_WEB_IMAGE="$web_image"; }
start_release() {
  use_images
  compose up -d --no-build --wait --wait-timeout 120 api web >/dev/null 2>&1
}
