#!/usr/bin/env bash
# One attempt after the observed TLS repair; never rerun deploy-staging.sh.
set -euo pipefail
umask 077

usage() {
  cat <<'HELP'
Usage: bash resume-staging.sh --check | --run
--check is read-only: verify the existing backup/TLS, untouched new targets,
  release archive, and observed Nginx configuration. No credentials are printed.
--run repeats those checks, then creates one private attempt directory and runs:
  database-env -> extract -> dependencies -> validate -> migrate -> unit -> start
  -> current symlink -> cutover prepare. Public Nginx is never changed/reloaded.
This script does not repair TLS, repeat the old backup, or resume a partial run.
On failure, preserve the phase logs/markers and reconcile the actual state;
do not remove the attempt directory or rerun either staging driver blindly.
HELP
}
case "${1:-help}" in
  help|--help) usage; exit 0 ;;
  --check|--run) [ "$#" = 1 ] || { usage >&2; exit 2; } ;;
  *) usage >&2; exit 2 ;;
esac
mode=$1
phase=preconditions
attempt=
finish() {
  code=$?
  if [ "$code" -ne 0 ]; then
    printf 'RESUME_FAILED phase=%s exit=%s; inspect partial state, do not rerun drivers\n' "$phase" "$code" >&2
    if [ -n "$attempt" ] && [ -d "$attempt" ]; then
      printf 'phase=%s exit=%s time=%s\n' "$phase" "$code" "$(date -u +%FT%TZ)" > "$attempt/FAILED"
    fi
  fi
}
trap finish EXIT
fail() { printf 'ERROR %s\n' "$1" >&2; exit 1; }
absent() { [ ! -e "$1" ] && [ ! -L "$1" ] || fail "Existing target requires reconciliation: $1"; }
[ "$(id -u)" = 0 ] && [ "$(uname -s)" = Linux ] || fail 'Target Linux root required'

ops=/root/duduhire-transfer-20260912
backup=/root/duduhire-backups/20260912T134804Z-4fe2ad
archive=/root/duduhire-20260912-native-3.tar.gz
archive_sha=8a10991fb705b9641ac536484c417fe4a26625edee416546be5d5b10ad50c6bc
release_id=duduhire-20260912-native-3
release=/opt/duduhire/releases/$release_id
attempt_path=$ops/resume-staging-attempt
plan=$ops/cutover-plan
nginx_config=/etc/nginx/conf.d/kylesong.conf
nginx_sha=03813275fd24f9bbfb8b6ee47d4ecffb2d50b7c4f0ba1b210bef3ec22c02575d
candidate_sha=adfd82b832299e853cbdbda95ab48d60177424867997198144fddd66b375e0a4
# Use the server's existing Node/PG tools; never inherit Node loader overrides.
export PATH=/usr/local/bin:/usr/pgsql-13/bin:/usr/sbin:/usr/bin:/sbin:/bin
unset NODE_OPTIONS NODE_EXTRA_CA_CERTS NODE_TLS_REJECT_UNAUTHORIZED
export PYTHONDONTWRITEBYTECODE=1
for program in node python3 bash sha256sum tar ss systemctl tee; do
  command -v "$program" >/dev/null || fail "Required tool unavailable: $program"
done
cd "$ops"
absent "$attempt_path"
for path in "$release" /opt/duduhire/current "$plan" /etc/systemd/system/duduhire-api-staging.service; do
  absent "$path"
done
listeners=$(ss -H -ltn 'sport = :8788')
[ -z "$listeners" ] || fail 'Port 8788 occupied; inspect existing service'
unit_state=$(systemctl show duduhire-api-staging.service --property=LoadState --value)
[ "$unit_state" = not-found ] || fail 'A staging unit is already known to systemd; inspect its state'
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<22||(a===22&&b<13))process.exit(1)'

# Import only bootstrap's read helpers. This emits metadata, never env contents.
python3 - "$ops" "$backup" "$archive" <<'PY'
import importlib.util
import json
import stat
import sys
from pathlib import Path

def check(ok, message):
    if not ok:
        raise RuntimeError(message)

def regular(path, mode=None):
    info = path.lstat()
    check(path.resolve() == path and stat.S_ISREG(info.st_mode)
          and info.st_uid == 0 and info.st_nlink == 1, "root_regular_file_required:" + path.name)
    check(not info.st_mode & 0o022, "writable_by_others:" + path.name)
    if mode is not None:
        check(stat.S_IMODE(info.st_mode) == mode, "private_file_mode_required:" + path.name)

try:
    ops, target, archive = map(Path, sys.argv[1:])
    check(ops.resolve() == ops and ops.is_dir() and ops.stat().st_uid == 0
          and not ops.stat().st_mode & 0o022, "private_ops_directory_required")
    for name in ("bootstrap.py", "stage.sh", "cutover.py", "package-native.mjs"):
        regular(ops / name)
    regular(archive)
    regular(Path(str(archive) + ".sha256"))
    regular(Path("/root/provider-secrets.json"), 0o600)
    spec = importlib.util.spec_from_file_location("bootstrap", str(ops / "bootstrap.py"))
    bootstrap = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bootstrap)
    bootstrap.selected_backup(str(target))
    for name in ("backup-complete.json", "backup-manifest.json", "tls-complete.json"):
        regular(target / name, 0o600)
    completed = json.loads((target / "backup-complete.json").read_text())
    check(completed["id"] == target.name and completed["manifestSha256"] == bootstrap.digest(target / "backup-manifest.json"),
          "verified_backup_manifest_required")
    tls = json.loads((target / "tls-complete.json").read_text())
    check(tls["ca"] == "/etc/duduhire/ca.crt" and tls["port"] == 5432
          and tls["host"] in ("127.0.0.1", "localhost")
          and tls["verified"] == "local certificate-verified TLS handshake", "verified_TLS_marker_required")
    ca = Path(tls["ca"])
    regular(ca)
    check(bootstrap.digest(ca) == tls["caSha256"], "CA_changed_since_TLS_marker")
    inventory = bootstrap.inventory()
    check(inventory["settings"]["ssl"] == "on", "PostgreSQL_SSL_must_be_on")
    bootstrap.tls_probe(ca, tls["host"], tls["port"])
    check("zjad" in inventory["databases"] and "duduhire" not in inventory["databases"]
          and not inventory["roles"], "new_database_or_roles_exist_reconcile_partial_state")
    for path in [target / "database-env-complete.json", target / "pg_hba.conf.before"] + [
            Path("/etc/duduhire") / (name + ".env") for name in ("runtime", "migration", "maintenance")]:
        check(not path.exists() and not path.is_symlink(), "partial_database_env_target_exists:" + path.name)
    hba = Path(inventory["settings"]["hba_file"])
    check(not hba.is_symlink() and b"BEGIN DUDUHIRE" not in hba.read_bytes(), "existing_DuduHire_HBA_requires_reconciliation")
    print("preconditions_verified=true; backup_manifest=true; live_verified_TLS=true; new_database_targets_absent=true")
except Exception as error:
    # Bootstrap's Stop/our own checks contain only fixed metadata; never dump input.
    detail = str(error) if isinstance(error, RuntimeError) else type(error).__name__
    print("ERROR resume_preconditions=" + detail, file=sys.stderr)
    sys.exit(1)
PY
printf '%s  %s\n' "$archive_sha" "$archive" | sha256sum --check --quiet
node "$ops/package-native.mjs" --verify "$archive"
printf '%s  %s\n' "$nginx_sha" "$nginx_config" | sha256sum --check --quiet
if [ "$mode" = --check ]; then
  printf 'RESUME_CHECK_PASSED; read-only; TLS/backup/release verified; new deployment targets absent\n'
  exit 0
fi

# Atomic mkdir reserves this single attempt. A failed or completed attempt blocks reruns.
mkdir -m 0700 "$attempt_path"
attempt=$attempt_path
printf 'phase=preconditions time=%s\n' "$(date -u +%FT%TZ)" > "$attempt/preconditions.complete"
printf 'backup=%s\nrelease=%s\narchive_sha256=%s\n' "$backup" "$release_id" "$archive_sha" > "$attempt/context.log"
run_phase() {
  phase=$1
  shift
  printf 'phase=%s time=%s\n' "$phase" "$(date -u +%FT%TZ)" > "$attempt/$phase.started"
  printf 'RESUME_PHASE_START %s\n' "$phase"
  "$@" 2>&1 | tee "$attempt/$phase.log"
  printf 'phase=%s time=%s\n' "$phase" "$(date -u +%FT%TZ)" > "$attempt/$phase.complete"
  printf 'RESUME_PHASE_COMPLETE %s\n' "$phase"
}
database_env() {
  python3 "$ops/bootstrap.py" database-env --backup "$backup" --provider /root/provider-secrets.json
  [ -f "$backup/database-env-complete.json" ] && [ ! -L "$backup/database-env-complete.json" ]
}
extract_release() {
  absent "$release"
  # Recheck immediately before extracting, without replacing any existing file.
  printf '%s  %s\n' "$archive_sha" "$archive" | sha256sum --check --quiet
  mkdir -m 0755 "$release"
  tar -xzf "$archive" -C "$release" --no-same-owner --keep-old-files
  (cd "$release" && sha256sum --check --quiet SHA256SUMS)
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

run_phase database-env database_env
run_phase extract extract_release
run_phase dependencies bash "$ops/stage.sh" dependencies "$release_id"
export DUDUHIRE_CA_FILE=/etc/duduhire/ca.crt
for step in validate migrate unit start; do
  run_phase "$step" bash "$ops/stage.sh" "$step" "$release_id"
done
run_phase symlink create_current
run_phase cutover-prepare prepare_cutover
phase=complete
printf 'time=%s\n' "$(date -u +%FT%TZ)" > "$attempt/COMPLETE"
printf 'STAGING_READY release=%s backup=%s plan=%s logs=%s; public nginx unchanged\n' "$release_id" "$backup" "$plan" "$attempt"
