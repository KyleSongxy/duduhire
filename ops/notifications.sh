#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"
[[ $# = 4 && $1 = --env-file && $3 = --confirm && $4 = NOTIFY ]] || die 'Usage: bash ops/notifications.sh --env-file /secret/production.env --confirm NOTIFY'
env_file=$2
need docker; need jq
validate_env_file
configured=$(compose config --format json 2>/dev/null | jq -er '.services.notifications.environment | (.NOTIFICATION_DATABASE_URL != "" and .INQUIRY_NOTIFICATION_EMAIL != "")') || die 'Notification worker configuration is unavailable.'
[[ $configured = true ]] || die 'Configure the independent notification database connection and a confirmed recipient before enabling the worker.'
exec docker compose --env-file "$env_file" -f "$DUDUHIRE_REPO_ROOT/compose.production.yaml" --profile notifications run --rm --no-deps --name duduhire-notifications notifications
