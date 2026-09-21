#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
for script in "$root"/ops/*.sh "$root"/ops/test-fixtures/*; do bash -n "$script"; done
for script in deploy rollback backup restore-check maintenance notifications; do
  if bash "$root/ops/$script.sh" >/dev/null 2>&1; then printf 'Missing confirmation accepted: %s\n' "$script" >&2; exit 1; fi
done
if bash "$root/ops/healthcheck.sh" --origin 'https://user:password@example.com/private?token=secret' >/dev/null 2>&1; then
  printf 'Sensitive URL accepted by healthcheck.\n' >&2; exit 1
fi
command -v jq >/dev/null || { printf 'jq is required for release safety tests.\n' >&2; exit 1; }
fixture=$(mktemp -d)
# These are synthetic local fixtures. Keep failures for inspection; never invoke a real Docker daemon.
mkdir "$fixture/bin" "$fixture/state"
cp "$root/ops/test-fixtures/docker" "$fixture/bin/docker"
cp "$root/ops/test-fixtures/psql" "$fixture/bin/psql"
cp "$root/ops/test-fixtures/curl" "$fixture/bin/curl"
cp "$root/ops/test-fixtures/forbidden-command" "$fixture/bin/pg_restore"
cp "$root/ops/test-fixtures/forbidden-command" "$fixture/bin/age"
chmod 700 "$fixture/bin/docker" "$fixture/bin/psql" "$fixture/bin/curl" "$fixture/bin/pg_restore" "$fixture/bin/age"
printf 'TEST_PLACEHOLDER=not-a-secret\n' > "$fixture/production.env"
chmod 600 "$fixture/production.env"
export PATH="$fixture/bin:$PATH" DUDUHIRE_OPS_TEST=true
export DUDUHIRE_TEST_CALLS="$fixture/calls" DUDUHIRE_TEST_MARKER="$fixture/failed-up"
export DUDUHIRE_TEST_API='ghcr.io/test/api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
export DUDUHIRE_TEST_WEB='ghcr.io/test/web@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
args=(--env-file "$fixture/production.env" --state-dir "$fixture/state" --backup-reference test --database-ready --rollback-compatible --confirm DEPLOY)
export DUDUHIRE_TEST_FAIL_PULL=true
if bash "$root/ops/deploy.sh" "${args[@]}" >/dev/null 2>&1; then printf 'Pull failure did not fail deployment.\n' >&2; exit 1; fi
if rg -q 'up -d|stop web api' "$fixture/calls"; then printf 'Pull failure changed running services.\n' >&2; exit 1; fi
unset DUDUHIRE_TEST_FAIL_PULL
bash "$root/ops/deploy.sh" "${args[@]}" >/dev/null
cmp -s <(printf 'api=%s\nweb=%s\n' "$DUDUHIRE_TEST_API" "$DUDUHIRE_TEST_WEB") "$fixture/state/current.release"
cp "$fixture/state/current.release" "$fixture/expected.release"
export DUDUHIRE_TEST_API='ghcr.io/test/api@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
export DUDUHIRE_TEST_WEB='ghcr.io/test/web@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
export DUDUHIRE_TEST_FAIL_FIRST_UP=true
if bash "$root/ops/deploy.sh" "${args[@]}" >/dev/null 2>&1; then printf 'Unhealthy release did not fail deployment.\n' >&2; exit 1; fi
if rg -q 'stop web api' "$fixture/calls"; then printf 'Healthy rollback was stopped.\n' >&2; exit 1; fi
cmp -s "$fixture/expected.release" "$fixture/state/current.release"
export DUDUHIRE_TEST_FORBIDDEN="$fixture/forbidden"
touch "$fixture/backup.age" "$fixture/identity.key"
restore_args=(--service isolated --backup "$fixture/backup.age" --identity "$fixture/identity.key" --confirm RESTORE_ISOLATED)
if bash "$root/ops/restore-check.sh" "${restore_args[@]}" >/dev/null 2>&1; then printf 'Production database accepted as restore target.\n' >&2; exit 1; fi
export DUDUHIRE_TEST_RESTORE_DB=duduhire_restore_test
if bash "$root/ops/restore-check.sh" "${restore_args[@]}" >/dev/null 2>&1; then printf 'Nonempty database accepted as restore target.\n' >&2; exit 1; fi
[[ ! -e $DUDUHIRE_TEST_FORBIDDEN ]] || { printf 'Unsafe restore command was executed.\n' >&2; exit 1; }
bash "$root/ops/healthcheck.sh" --origin https://health.example.test >/dev/null
export DUDUHIRE_TEST_BAD_HEALTH_BODY=true
if bash "$root/ops/healthcheck.sh" --origin https://health.example.test >/dev/null; then printf 'HTML fallback was accepted as a healthy API.\n' >&2; exit 1; fi
printf 'Operation confirmation, release/rollback and unsafe restore-target guards passed. Synthetic fixtures: %s\n' "$fixture"
