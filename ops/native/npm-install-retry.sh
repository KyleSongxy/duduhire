#!/usr/bin/env bash
# Reconcile only the observed failed dependencies phase; preserve all prior attempts.
set -euo pipefail
umask 077
usage() {
  cat <<'HELP'
Usage: bash npm-install-retry.sh --check|--run REGISTRY
REGISTRY must explicitly be https://registry.npmjs.org or https://registry.npmmirror.com.
--check validates the recorded dependency failure and unchanged release; no writes.
--run preserves partial node_modules/cache in a new private attempt, installs
dependencies using that registry, then runs original validate/migrate/unit/start,
creates current, and prepares cutover. No database bootstrap, release extraction,
Nginx apply/reload, or deletion of old attempts. A failed retry requires inspection.
HELP
}
case "${1:-help}" in help|--help) usage; exit 0;; esac
[ "$#" = 2 ] || { usage >&2; exit 2; }
case "$1" in --check|--run) mode=$1;; *) usage >&2; exit 2;; esac
registry=$2
case "$registry" in
  https://registry.npmjs.org|https://registry.npmmirror.com) ;;
  *) printf 'ERROR registry must be an approved explicit HTTPS URL\n' >&2; exit 2 ;;
esac
phase=preconditions
attempt=
finish() {
  code=$?
  if [ "$code" -ne 0 ]; then
    printf 'NPM_RETRY_FAILED phase=%s exit=%s; inspect retained state before retry\n' "$phase" "$code" >&2
    if [ -n "$attempt" ]; then
      printf 'phase=%s exit=%s time=%s\n' "$phase" "$code" "$(date -u +%FT%TZ)" > "$attempt/FAILED"
    fi
  fi
}
trap finish EXIT
fail() { printf 'ERROR %s\n' "$1" >&2; exit 1; }
absent() { [ ! -e "$1" ] && [ ! -L "$1" ] || fail "Existing target requires inspection: $1"; }
[ "$(id -u)" = 0 ] && [ "$(uname -s)" = Linux ] || fail 'Target Linux root required'
export PATH=/usr/local/bin:/usr/pgsql-13/bin:/usr/sbin:/usr/bin:/sbin:/bin
unset NODE_OPTIONS NODE_EXTRA_CA_CERTS NODE_TLS_REJECT_UNAUTHORIZED
export PYTHONDONTWRITEBYTECODE=1
ops=/root/duduhire-transfer-20260912
prior=$ops/stage-after-database-repair-attempt
attempt_path=$ops/npm-install-retry-attempt
release_id=duduhire-20260912-native-3
release=/opt/duduhire/releases/$release_id
archive=/root/duduhire-20260912-native-3.tar.gz
archive_sha=8a10991fb705b9641ac536484c417fe4a26625edee416546be5d5b10ad50c6bc
nginx_config=/etc/nginx/conf.d/kylesong.conf
nginx_sha=03813275fd24f9bbfb8b6ee47d4ecffb2d50b7c4f0ba1b210bef3ec22c02575d
candidate_sha=adfd82b832299e853cbdbda95ab48d60177424867997198144fddd66b375e0a4
plan=$ops/cutover-plan
for program in python3 bash sha256sum tar cmp ss systemctl tee pgrep; do
  command -v "$program" >/dev/null || fail "Required tool unavailable: $program"
done
for path in "$attempt_path" /opt/duduhire/current /etc/systemd/system/duduhire-api-staging.service "$plan"; do
  absent "$path"
done
[ "$(systemctl show duduhire-api-staging.service --property=LoadState --value)" = not-found ] || fail 'Staging unit already known to systemd'
[ -z "$(ss -H -ltn 'sport = :8788')" ] || fail 'Port 8788 already occupied'
python3 - "$ops" "$prior" "$release" <<'PY'
import os
from pathlib import Path
import pwd
import re
import stat
import subprocess
import sys

def check(ok, reason):
    if not ok:
        raise RuntimeError(reason)

def metadata(path, directory=False, mode=None):
    info = path.lstat()
    check(path.resolve() == path and info.st_uid == 0 and not info.st_mode & 0o022,
          "root_owned_real_path_required")
    check(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode) and info.st_nlink == 1,
          "unexpected_file_type")
    check(mode is None or stat.S_IMODE(info.st_mode) == mode, "unexpected_permissions")

try:
    ops, prior, release = map(Path, sys.argv[1:])
    metadata(ops, True)
    metadata(prior, True, 0o700)
    metadata(release, True)
    for name in ("stage.sh", "stage-registry-retry.sh", "cutover.py"):
        metadata(ops / name)
    for name in ("FAILED", "extract.complete", "dependencies.started"):
        metadata(prior / name, mode=0o600)
    check(re.fullmatch(r"phase=dependencies exit=[1-9][0-9]* time=\S+\n", (prior / "FAILED").read_text()) is not None,
          "only_recorded_dependencies_failure_can_be_retried")
    for name in ("dependencies.complete", "validate.started", "migrate.started", "unit.started", "start.started", "COMPLETE"):
        check(not (prior / name).exists() and not (prior / name).is_symlink(), "prior_staging_progress_requires_reconciliation")
    for name in ("SHA256SUMS", "package-lock.json", "RELEASE.json"):
        metadata(release / name)
    metadata(release / "node_modules", True)
    metadata(release / ".native-install", True, 0o700)
    for name in ("apps/api/node_modules", "apps/web/node_modules", ".npmrc"):
        check(not (release / name).exists() and not (release / name).is_symlink(), "unexpected_nested_install_requires_review")
    account = pwd.getpwnam("duduhire")
    check(account.pw_uid != 0 and account.pw_dir == "/nonexistent" and account.pw_shell.endswith("nologin"),
          "dedicated_service_identity_required")
    process = subprocess.run(["pgrep", "-u", str(account.pw_uid)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    check(process.returncode == 1, "service_user_processes_present_or_inspection_failed")
    print("dependency_retry_preconditions=true; original_failure_confirmed=true; service_user_idle=true")
except Exception as error:
    print("ERROR dependency_retry_preconditions=" + (str(error) if isinstance(error, RuntimeError) else type(error).__name__), file=sys.stderr)
    sys.exit(1)
PY
# Bind the release manifest to the already approved archive, not to mutable files.
printf '%s  %s\n' "$archive_sha" "$archive" | sha256sum --check --quiet
tar -xOf "$archive" SHA256SUMS | cmp - "$release/SHA256SUMS"
(cd "$release" && sha256sum --check --quiet SHA256SUMS)
printf '%s  %s\n' "$nginx_sha" "$nginx_config" | sha256sum --check --quiet
if [ "$mode" = --check ]; then
  printf 'NPM_RETRY_CHECK_PASSED registry=%s; read-only; original release/lockfile verified\n' "$registry"
  exit 0
fi

mkdir -m 0700 "$attempt_path"
attempt=$attempt_path
printf 'phase=preconditions time=%s\n' "$(date -u +%FT%TZ)" > "$attempt/preconditions.complete"
printf 'registry=%s\nprior_attempt=%s\nrelease=%s\n' "$registry" "$prior" "$release_id" > "$attempt/context.log"
run_phase() {
  phase=$1
  shift
  printf 'phase=%s time=%s\n' "$phase" "$(date -u +%FT%TZ)" > "$attempt/$phase.started"
  printf 'NPM_RETRY_PHASE_START %s\n' "$phase"
  "$@" 2>&1 | tee "$attempt/$phase.log"
  printf 'phase=%s time=%s\n' "$phase" "$(date -u +%FT%TZ)" > "$attempt/$phase.complete"
  printf 'NPM_RETRY_PHASE_COMPLETE %s\n' "$phase"
}
preserve_partial() {
  # Move entries without following their internal symlinks; /root and attempt are private.
  mv "$release/node_modules" "$attempt/partial-node_modules"
  mv "$release/.native-install" "$attempt/partial-native-install"
  absent "$release/node_modules"
  absent "$release/.native-install"
  printf 'Partial dependencies and npm cache retained under this private attempt\n'
}
dependencies() {
  DUDUHIRE_NPM_REGISTRY="$registry" bash "$ops/stage-registry-retry.sh" dependencies "$release_id"
  (cd "$release" && sha256sum --check --quiet SHA256SUMS)
  tar -xOf "$archive" SHA256SUMS | cmp - "$release/SHA256SUMS"
}
create_current() {
  printf '%s  %s\n' "$nginx_sha" "$nginx_config" | sha256sum --check --quiet
  absent /opt/duduhire/current
  ln -s "releases/$release_id" /opt/duduhire/current
  [ "$(readlink -f /opt/duduhire/current)" = "$release" ]
}
prepare_cutover() {
  absent "$plan"
  python3 "$ops/cutover.py" prepare --output "$plan"
  printf '%s  %s\n' "$candidate_sha" "$plan/candidate.conf" | sha256sum --check --quiet
  printf '%s  %s\n' "$nginx_sha" "$nginx_config" | sha256sum --check --quiet
}
run_phase preserve-partial preserve_partial
run_phase dependencies dependencies
export DUDUHIRE_CA_FILE=/etc/duduhire/ca.crt
for step in validate migrate unit start; do
  run_phase "$step" bash "$ops/stage.sh" "$step" "$release_id"
done
run_phase symlink create_current
run_phase cutover-prepare prepare_cutover
phase=complete
printf 'time=%s\n' "$(date -u +%FT%TZ)" > "$attempt/COMPLETE"
printf 'STAGING_READY release=%s registry=%s plan=%s logs=%s; public nginx unchanged\n' "$release_id" "$registry" "$plan" "$attempt"
