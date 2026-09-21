#!/usr/bin/env bash
# Finalize native-3 only after the operator's completed public HTTPS acceptance.
set -euo pipefail
umask 077
usage() {
  cat <<'HELP'
Usage: bash finalize-services.sh --check | --run
--check is repeatable/read-only: verify native-3, active candidate Nginx, new API,
  installed-file compatibility, service metadata and Certbot renewal method/paths.
--run records one private attempt, installs absent reviewed backup files, creates
  and lists a fresh dump, enables backup timer/new API, then stops/disables the
  two old kylesong services. Old files/databases and Certbot remain unchanged.
Existing installed files must match exactly; a prior run attempt blocks reruns.
Public acceptance was performed separately; this script repeats loopback health.
HELP
}
case "${1:-help}" in help|--help) usage; exit 0;; esac
[ "$#" = 1 ] || { usage >&2; exit 2; }
case "$1" in --check|--run) mode=$1;; *) usage >&2; exit 2;; esac
phase=preconditions
attempt=
finish() {
  code=$?
  if [ "$code" -ne 0 ]; then
    printf 'FINALIZE_FAILED phase=%s exit=%s; inspect retained logs and service state\n' "$phase" "$code" >&2
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
release_id=duduhire-20260912-native-3
release=/opt/duduhire/releases/$release_id
archive=/root/duduhire-20260912-native-3.tar.gz
archive_sha=8a10991fb705b9641ac536484c417fe4a26625edee416546be5d5b10ad50c6bc
nginx_config=/etc/nginx/conf.d/kylesong.conf
candidate_sha=adfd82b832299e853cbdbda95ab48d60177424867997198144fddd66b375e0a4
attempt_path=$ops/finalize-services-attempt
api=duduhire-api-staging.service
backup_service=duduhire-backup.service
backup_timer=duduhire-backup.timer

health() {
  systemctl is-active --quiet "$api"
  /usr/local/bin/node --input-type=module <<'HEALTH'
try {
  for(const [path,status] of [['/api/health/live','ok'],['/api/health/ready','ready']]) {
    const response=await fetch('http://127.0.0.1:8788'+path,{signal:AbortSignal.timeout(5000)});
    if(!response.ok || (await response.json()).status!==status) throw new Error();
  }
  const response=await fetch('http://127.0.0.1:8788/api/v1/auth/methods',{signal:AbortSignal.timeout(5000)});
  const methods=await response.json();
  if(!response.ok || typeof methods.email?.available!=='boolean' || typeof methods.phone?.available!=='boolean') throw new Error();
  console.log(JSON.stringify({localLive:true,localReady:true,emailAvailable:methods.email.available,phoneAvailable:methods.phone.available}));
} catch { console.error('ERROR new API health failed'); process.exitCode=1; }
HEALTH
}

preflight() {
  [ -L /opt/duduhire/current ] && [ "$(readlink -f /opt/duduhire/current)" = "$release" ] || fail 'Current must target native-3'
  [ "$(systemctl show "$api" --property=WorkingDirectory --value)" = "$release" ] || fail 'Active unit release differs'
  [ "$(systemctl show "$api" --property=User --value)" = duduhire ] || fail 'Dedicated API service user required'
  printf '%s  %s\n' "$candidate_sha" "$nginx_config" | sha256sum --check --quiet
  printf '%s  %s\n' "$archive_sha" "$archive" | sha256sum --check --quiet
  tar -xOf "$archive" SHA256SUMS | cmp - "$release/SHA256SUMS"
  (cd "$release" && sha256sum --check --quiet SHA256SUMS)
  python3 - "$ops" "$release" <<'PREFLIGHT'
import hashlib
from pathlib import Path
import stat
import sys

def check(ok):
    if not ok:
        raise RuntimeError("path_permissions_or_installed_file_mismatch")

def regular(path, mode=None):
    info=path.lstat()
    check(path.resolve()==path and stat.S_ISREG(info.st_mode) and info.st_uid==0
          and info.st_nlink==1 and not info.st_mode & 0o022)
    check(mode is None or stat.S_IMODE(info.st_mode)==mode)

try:
    ops,release=map(Path,sys.argv[1:])
    for path in (ops,release,Path('/etc/duduhire'),Path('/opt/duduhire')):
        info=path.lstat()
        check(path.resolve()==path and stat.S_ISDIR(info.st_mode) and info.st_uid==0 and not info.st_mode & 0o022)
    for name in ('runtime.env','migration.env'):
        regular(Path('/etc/duduhire')/name,0o600)
    regular(Path('/etc/duduhire/ca.crt'))
    regular(Path('/etc/systemd/system/duduhire-api-staging.service'),0o644)
    definitions=[
      ('backup-duduhire.mjs','/opt/duduhire/ops/backup-duduhire.mjs','f2c36a2ceeeb069c13f18cf07f693393179a4003a1fd62bd084f38426df7ed81'),
      ('duduhire-backup.service','/etc/systemd/system/duduhire-backup.service','6e7359db4e261bf460a9f5d67e5268fca4ba6a7d95b70b8ee053749df6f3e7c3'),
      ('duduhire-backup.timer','/etc/systemd/system/duduhire-backup.timer','212f878e827f2e9906efec0fcab72caa6d88ffe92627e146cfec018401bec4a1'),
    ]
    for name,destination,digest in definitions:
        source=ops/name
        regular(source)
        check(hashlib.sha256(source.read_bytes()).hexdigest()==digest)
        target=Path(destination)
        if target.exists() or target.is_symlink():
            regular(target,0o644)
            check(target.read_bytes()==source.read_bytes())
    directory=Path('/opt/duduhire/ops')
    if directory.exists() or directory.is_symlink():
        info=directory.lstat()
        check(directory.resolve()==directory and stat.S_ISDIR(info.st_mode) and info.st_uid==0
              and stat.S_IMODE(info.st_mode)==0o755)
    directory=Path('/var/lib/duduhire-backup')
    if directory.exists() or directory.is_symlink():
        info=directory.lstat()
        check(directory.resolve()==directory and stat.S_ISDIR(info.st_mode) and info.st_uid==0
              and stat.S_IMODE(info.st_mode)==0o700)
    print('release_and_backup_installation_guards=true; existing_targets_preserved=true')
except Exception:
    print('ERROR finalization file/release metadata mismatch; no file overwritten',file=sys.stderr)
    sys.exit(1)
PREFLIGHT
  health
}

snapshot() {
  printf 'snapshot_utc=%s\n' "$(date -u +%FT%TZ)"
  for unit in "$api" "$backup_service" "$backup_timer" kylesong-api.service kylesong-outbox.service nginx.service postgresql.service certbot.timer; do
    printf 'service=%s\n' "$unit"
    systemctl show "$unit" --property=LoadState,ActiveState,SubState,UnitFileState,MainPID,ExecMainPID,ExecMainStartTimestamp,ActiveEnterTimestamp,NRestarts,Result,ExecMainStatus
  done
  python3 - <<'CERTBOT'
import json
from pathlib import Path
import re
path=Path('/etc/letsencrypt/renewal/kylesong.top.conf')
result={'renewalFile':str(path),'checkedOnly':True,'authenticator':None,'installer':None,'webrootPaths':[]}
if path.is_file() and not path.is_symlink():
    section=''
    for line in path.read_text().splitlines():
        line=line.strip()
        if line.startswith('['):
            section=line
            continue
        if '=' not in line or line.startswith('#'):
            continue
        key,value=(part.strip() for part in line.split('=',1))
        if section=='[renewalparams]' and key in ('authenticator','installer'):
            result[key]=value if re.fullmatch(r'[A-Za-z0-9_-]+',value) else 'unrecognized-format'
        if (section=='[renewalparams]' and key=='webroot_path') or (
            section=='[[webroot_map]]' and key in ('kylesong.top','www.kylesong.top','api.kylesong.top')):
            for value in value.split(','):
                value=value.strip()
                if re.fullmatch(r'/[A-Za-z0-9_./-]*',value):
                    result['webrootPaths'].append(value)
    result['webrootPaths']=sorted(set(result['webrootPaths']))
    result['oldWebrootNeedsReview']=result['authenticator']=='webroot' and '/var/www/kylesong' in result['webrootPaths']
else:
    result['status']='renewal_configuration_missing_or_symlinked'
print(json.dumps(result,sort_keys=True))
CERTBOT
}

install_absent() {
  source=$1
  target=$2
  if [ -e "$target" ] || [ -L "$target" ]; then
    [ -f "$target" ] && [ ! -L "$target" ] && cmp -s "$source" "$target" || fail 'Existing installed target differs'
    return
  fi
  # O_EXCL creation prevents an intervening file from being overwritten.
  python3 - "$source" "$target" <<'INSTALL'
import os
from pathlib import Path
import sys
source,target=map(Path,sys.argv[1:])
descriptor=os.open(str(target),os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o644)
with os.fdopen(descriptor,'wb') as output:
    output.write(source.read_bytes())
    output.flush()
    os.fchmod(output.fileno(),0o644)
    os.fsync(output.fileno())
INSTALL
}
install_backup() {
  # Neither an active timer nor an in-progress oneshot may race the first dump.
  for unit in "$backup_timer" "$backup_service"; do
    case "$(systemctl show "$unit" --property=ActiveState --value)" in
      inactive|failed) ;;
      *) fail 'Existing active backup job/timer requires reconciliation' ;;
    esac
  done
  if [ ! -d /opt/duduhire/ops ]; then mkdir -m 0755 /opt/duduhire/ops; fi
  install_absent "$ops/backup-duduhire.mjs" /opt/duduhire/ops/backup-duduhire.mjs
  install_absent "$ops/duduhire-backup.service" /etc/systemd/system/duduhire-backup.service
  install_absent "$ops/duduhire-backup.timer" /etc/systemd/system/duduhire-backup.timer
  systemd-analyze verify /etc/systemd/system/duduhire-backup.service /etc/systemd/system/duduhire-backup.timer
  systemctl daemon-reload
}
first_backup() {
  python3 - "$attempt/backup-before.json" <<'BEFORE'
import json
from pathlib import Path
import sys
directory=Path('/var/lib/duduhire-backup')
with open(sys.argv[1],'x') as output:
    json.dump(sorted(p.name for p in directory.iterdir()) if directory.exists() else [],output)
BEFORE
  systemctl start "$backup_service"
  [ "$(systemctl show "$backup_service" --property=Result --value)" = success ]
  [ "$(systemctl show "$backup_service" --property=ExecMainStatus --value)" = 0 ]
  fresh_dump=$(python3 - "$attempt/backup-before.json" <<'FRESH'
import json
from pathlib import Path
import re
import stat
import sys
directory=Path('/var/lib/duduhire-backup')
info=directory.lstat()
if directory.resolve()!=directory or not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or stat.S_IMODE(info.st_mode)!=0o700:
    sys.exit('ERROR backup_directory_metadata_invalid')
prior=set(json.loads(Path(sys.argv[1]).read_text()))
fresh=[p for p in directory.iterdir() if p.name not in prior and re.fullmatch(r'duduhire-[0-9]{8}T[0-9]{9}Z-[a-f0-9]{12}\.dump',p.name)]
if len(fresh)!=1:
    sys.exit('ERROR exactly_one_fresh_backup_required')
path=fresh[0]
info=path.lstat()
if not stat.S_ISREG(info.st_mode) or path.is_symlink() or info.st_uid!=0 or info.st_nlink!=1 or stat.S_IMODE(info.st_mode)!=0o600 or info.st_size<=0:
    sys.exit('ERROR fresh_dump_metadata_invalid')
print(str(path))
FRESH
)
  pg_restore --list "$fresh_dump" >/dev/null 2>&1
  sha256sum "$fresh_dump" > "$attempt/first-backup.sha256"
  printf 'fresh_backup=%s; pg_restore_list=true; restore_executed=false\n' "$fresh_dump"
}
enable_new_services() {
  systemctl enable --now "$backup_timer"
  [ "$(systemctl is-enabled "$backup_timer")" = enabled ]
  systemctl is-active --quiet "$backup_timer"
  systemctl enable "$api"
  [ "$(systemctl is-enabled "$api")" = enabled ]
  health
}
retire_old_services() {
  health
  printf '%s  %s\n' "$candidate_sha" "$nginx_config" | sha256sum --check --quiet
  systemctl stop kylesong-api.service kylesong-outbox.service
  systemctl disable kylesong-api.service kylesong-outbox.service
  for unit in kylesong-api.service kylesong-outbox.service; do
    [ "$(systemctl show "$unit" --property=ActiveState --value)" = inactive ]
    [ "$(systemctl show "$unit" --property=UnitFileState --value)" = disabled ]
  done
  health
}

if [ "$mode" = --check ]; then
  preflight
  snapshot
  printf 'FINALIZE_CHECK_PASSED; no service, backup, or file changes\n'
  exit 0
fi
[ -d "$ops" ] && [ ! -L "$ops" ] && [ "$(stat -c %u "$ops")" = 0 ] || fail 'Root-owned transfer directory required'
absent "$attempt_path"
mkdir -m 0700 "$attempt_path"
attempt=$attempt_path
run_phase() {
  phase=$1
  shift
  printf 'phase=%s time=%s\n' "$phase" "$(date -u +%FT%TZ)" > "$attempt/$phase.started"
  printf 'FINALIZE_PHASE_START %s\n' "$phase"
  "$@" 2>&1 | tee "$attempt/$phase.log"
  printf 'phase=%s time=%s\n' "$phase" "$(date -u +%FT%TZ)" > "$attempt/$phase.complete"
  printf 'FINALIZE_PHASE_COMPLETE %s\n' "$phase"
}
run_phase preconditions preflight
run_phase services-before snapshot
run_phase install-backup install_backup
run_phase first-backup first_backup
run_phase enable-new-services enable_new_services
run_phase retire-old-services retire_old_services
run_phase services-after snapshot
phase=complete
printf 'time=%s\n' "$(date -u +%FT%TZ)" > "$attempt/COMPLETE"
printf 'FINALIZE_COMPLETE release=%s logs=%s; old files/databases preserved; no mail sent\n' "$release_id" "$attempt"
