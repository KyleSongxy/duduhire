#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"
env_file= state_dir= confirmation= database_compatible=false
while (($#)); do
  case $1 in
    --env-file) env_file=${2:?}; shift 2;;
    --state-dir) state_dir=${2:?}; shift 2;;
    --confirm) confirmation=${2:?}; shift 2;;
    --database-compatible) database_compatible=true; shift;;
    *) die 'Usage: bash ops/rollback.sh --env-file /secret/production.env --state-dir /var/lib/duduhire/releases --database-compatible --confirm ROLLBACK';;
  esac
done
[[ $confirmation = ROLLBACK && $database_compatible = true ]] || die 'Rollback requires ROLLBACK confirmation and explicit database compatibility verification.'
prepare_release
read_release "$state_dir/previous.release"
use_images
compose pull api web >/dev/null 2>&1 || die 'Previous image pull failed; existing services were not changed.'
if start_release; then
  write_release "$state_dir/current.release"
  printf '{"status":"rolled_back","databaseChanged":false}\n'
  exit 0
fi
if [[ -f $state_dir/current.release ]]; then
  read_release "$state_dir/current.release"
  if start_release; then die 'Rollback failed; the release that was running before the attempt is healthy again.'; fi
fi
compose stop web api >/dev/null 2>&1 || true
die 'Rollback failed and no healthy release could be restored. Web/API are stopped. Database migrations were not reversed.'
