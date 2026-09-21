#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"
service= backup= identity= confirmation=
while (($#)); do
  case $1 in
    --service) service=${2:?}; shift 2;;
    --backup) backup=${2:?}; shift 2;;
    --identity) identity=${2:?}; shift 2;;
    --confirm) confirmation=${2:?}; shift 2;;
    *) die 'Usage: bash ops/restore-check.sh --service isolated-restore --backup /secure/backup.dump.age --identity /secret/age.key --confirm RESTORE_ISOLATED';;
  esac
done
[[ $confirmation = RESTORE_ISOLATED && $service =~ ^[A-Za-z0-9_-]+$ && $backup = /* && -f $backup && $identity = /* && -f $identity ]] || die 'Restore requires explicit RESTORE_ISOLATED confirmation, a libpq service name, encrypted backup and identity files.'
need psql; need pg_restore; need age
database=$(psql "service=$service" -XAt --set=ON_ERROR_STOP=1 --command='SELECT current_database()' 2>/dev/null) || die 'Cannot inspect restore target.'
[[ $database =~ ^[A-Za-z0-9_]+_(restore_test|validation)$ ]] || die 'Restore target database must end in _restore_test or _validation.'
tables=$(psql "service=$service" -XAt --set=ON_ERROR_STOP=1 --command="SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p','v','m','f')" 2>/dev/null) || die 'Cannot verify empty restore target.'
[[ $tables = 0 ]] || die 'Restore target is not empty. Existing data will not be overwritten.'
if ! age --decrypt --identity "$identity" "$backup" 2>/dev/null | pg_restore --dbname="service=$service" --single-transaction --exit-on-error --no-owner --no-privileges 2>/dev/null; then
  die 'Isolated restore failed. Inspect the target privately; no application, email or AI process was started.'
fi
verified=$(psql "service=$service" -XAt --set=ON_ERROR_STOP=1 --command="SELECT CASE WHEN EXISTS (SELECT 1 FROM schema_migrations WHERE name='007_bilateral_matching.sql' AND checksum IS NOT NULL) AND to_regclass('public.users') IS NOT NULL AND to_regclass('public.discovery_turns') IS NOT NULL AND to_regclass('public.enterprise_inquiries') IS NOT NULL AND to_regclass('public.matching_listings') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE NOT convalidated) THEN 'ok' ELSE 'incomplete' END" 2>/dev/null) || die 'Restored schema verification failed.'
[[ $verified = ok ]] || die 'Restored database is missing required schema or validated constraints.'
history=$(psql "service=$service" -XAt --set=ON_ERROR_STOP=1 --command="SELECT name || ':' || checksum FROM schema_migrations ORDER BY name" 2>/dev/null) || die 'Cannot read restored migration checksums.'
for migration in "$DUDUHIRE_REPO_ROOT"/apps/api/migrations/*.sql; do
  if command -v sha256sum >/dev/null 2>&1; then checksum=$(sha256sum "$migration"); else need shasum; checksum=$(shasum -a 256 "$migration"); fi
  checksum=${checksum%% *}
  expected="$(basename "$migration"):$checksum"
  [[ $'\n'$history$'\n' = *$'\n'"$expected"$'\n'* ]] || die 'Restored migration history differs from this release. Do not start the application until the discrepancy is resolved.'
done
printf '{"status":"isolated_restore_verified","applicationStarted":false}\n'
