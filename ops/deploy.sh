#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"
env_file= state_dir= confirmation= backup_reference=
database_ready=false rollback_compatible=false
while (($#)); do
  case $1 in
    --env-file) env_file=${2:?}; shift 2;;
    --state-dir) state_dir=${2:?}; shift 2;;
    --backup-reference) backup_reference=${2:?}; shift 2;;
    --confirm) confirmation=${2:?}; shift 2;;
    --database-ready) database_ready=true; shift;;
    --rollback-compatible) rollback_compatible=true; shift;;
    *) die 'Usage: bash ops/deploy.sh --env-file /secret/production.env --state-dir /var/lib/duduhire/releases --backup-reference ID --database-ready --rollback-compatible --confirm DEPLOY';;
  esac
done
[[ $confirmation = DEPLOY && $database_ready = true && $rollback_compatible = true && -n $backup_reference ]] || die 'Deployment requires DEPLOY confirmation, a backup reference, completed migrations/grants, and confirmation that the previous API remains database-compatible.'
prepare_release
read_config_images
use_images
compose pull api web >/dev/null 2>&1 || die 'Image pull failed; existing services were not changed.'
# Record registry digests rather than mutable local tag resolution for later rollback.
api_image=$(docker image inspect "$api_image" --format '{{index .RepoDigests 0}}')
web_image=$(docker image inspect "$web_image" --format '{{index .RepoDigests 0}}')
immutable_image "$api_image" && immutable_image "$web_image" || die 'Pulled images do not have valid registry digests.'
if start_release; then
  if [[ -f $state_dir/current.release ]]; then cp "$state_dir/current.release" "$state_dir/previous.release"; fi
  write_release "$state_dir/current.release"
  printf '{"status":"deployed","databaseChanged":false}\n'
  exit 0
fi
printf 'New services did not become healthy.\n' >&2
if [[ -f $state_dir/current.release ]]; then
  read_release "$state_dir/current.release"
  if start_release; then
    die 'Deployment failed; the recorded previous images are healthy again. No database rollback was performed.'
  fi
fi
compose stop web api >/dev/null 2>&1 || true
die 'Deployment failed and no healthy recorded release could be restored. Web/API are stopped; preserve the database and investigate.'
