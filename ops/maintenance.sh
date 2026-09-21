#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"
[[ $# = 4 && $1 = --env-file && $3 = --confirm && $4 = CLEANUP ]] || die 'Usage: bash ops/maintenance.sh --env-file /secret/production.env --confirm CLEANUP'
env_file=$2
need docker
validate_env_file
compose --profile maintenance run --rm --no-deps maintenance
