#!/usr/bin/env bash
# Read-only inventory. Does not install, migrate, restart, edit, or fetch URLs.
# Run with bash, preferably as the already-authorized server administrator.
set -u
export LC_ALL=C
export SYSTEMD_PAGER=cat
export SYSTEMD_BUS_TIMEOUT=5s

errors=0
warnings=0
captured=''
capture_status=0

issue() {
  errors=$((errors + 1))
  printf 'ERROR %s\n' "$1"
}

warning() {
  warnings=$((warnings + 1))
  printf 'WARNING %s\n' "$1"
}

capture() {
  # Never forward stderr: provider/system errors may include sensitive context.
  if command -v timeout >/dev/null 2>&1; then
    captured=$(timeout 12 "$@" 2>/dev/null)
  else
    captured=$("$@" 2>/dev/null)
  fi
  capture_status=$?
  return "$capture_status"
}

show_command() {
  label=$1
  shift
  if capture "$@"; then
    printf '%s\n%s\n' "$label" "$captured"
  else
    issue "$label unavailable (exit=$capture_status)"
  fi
}

version_command() {
  program=$1
  if command -v "$program" >/dev/null 2>&1; then
    printf '%s.path=%s\n' "$program" "$(command -v "$program")"
    if [ "$program" = npm ]; then
      # Version inventory must not create npm cache/update-notifier/debug files.
      show_command "$program.version" env npm_config_cache=/dev/null \
        npm_config_logs_max=0 npm_config_update_notifier=false \
        npm_config_userconfig=/dev/null npm --version
    else
      show_command "$program.version" "$program" --version
    fi
  else
    issue "$program unavailable"
  fi
}

show_directory() {
  directory=$1
  if [ -L "$directory" ]; then
    printf 'directory=%s type=symlink\n' "$directory"
    if command -v readlink >/dev/null 2>&1; then
      show_command 'symlink.target' readlink "$directory"
    else
      issue "readlink unavailable for $directory"
    fi
  elif [ -d "$directory" ]; then
    printf 'directory=%s type=directory\n' "$directory"
  elif [ -e "$directory" ]; then
    printf 'directory=%s type=other-existing-entry\n' "$directory"
    warning "Expected directory path is occupied: $directory"
  else
    # Lack of directory traversal permission must not be called absent.
    parent=${directory%/*}
    if [ -d "$parent" ] && [ -x "$parent" ]; then
      printf 'directory=%s exists=false\n' "$directory"
    elif [ "$parent" = '/opt/duduhire' ] && [ ! -e /opt/duduhire ] && [ -x /opt ]; then
      printf 'directory=%s exists=false (parent absent)\n' "$directory"
    else
      issue "Directory existence unavailable: $directory"
    fi
  fi
}

show_unit() {
  unit=$1
  # Deliberately exclude Environment, ExecStart arguments, status output and logs.
  if capture systemctl show "$unit" --no-pager \
    --property=Id,LoadState,ActiveState,SubState,FragmentPath,WorkingDirectory,User,Group,MainPID; then
    printf 'unit=%s\n%s\n' "$unit" "$captured"
    case "$captured" in
      *'LoadState=not-found'*) warning "Unit absent: $unit" ;;
    esac
  else
    issue "Unit metadata unavailable: $unit (exit=$capture_status)"
  fi
}

printf 'DuduHire native preflight: READ ONLY\n'
printf 'No deployment approval or readiness claim is implied by this inventory.\n'
printf 'bash.version=%s\n' "$BASH_VERSION"
show_command 'execution.uid' id -u
version_command node
version_command npm
version_command psql

if command -v nginx >/dev/null 2>&1; then
  printf 'nginx.path=%s\n' "$(command -v nginx)"
  # nginx -v writes its public version to stderr; only extract that known line.
  nginx_version=$(nginx -v 2>&1 | awk '/^nginx version: nginx\// { print; found=1 } END { if (!found) exit 1 }')
  if [ -n "$nginx_version" ]; then
    printf '%s\n' "$nginx_version"
  else
    issue 'nginx version unavailable'
  fi
  # Do not use nginx -t/-T: configuration testing may open/create log files.
  # Read conventional configuration candidates only, never print their contents.
  nginx_roots=''
  for config in /etc/nginx/nginx.conf /etc/nginx/conf.d/*.conf /etc/nginx/sites-enabled/*; do
    [ -f "$config" ] && [ -r "$config" ] || continue
    if capture awk '
      /^[[:space:]]*root[[:space:]]+\// {
        path=$2; sub(/;$/, "", path)
        if (path ~ /^\/[A-Za-z0-9_./-]+$/) {
          printf "nginx.config_candidate=%s\nnginx.declared_web_root=%s\n", FILENAME, path
        }
      }
    ' "$config"; then
      if [ -n "$captured" ]; then nginx_roots="$nginx_roots
$captured"; fi
    else
      issue "Nginx configuration metadata unavailable: $config"
    fi
  done
  if [ -n "$nginx_roots" ]; then
    printf '%s\n' "$nginx_roots"
    warning 'Declared nginx roots are from conventional config files; custom includes/startup flags require review'
  else
    issue 'No plain absolute nginx web root identified in readable conventional configuration files'
  fi
else
  issue 'nginx unavailable in PATH'
fi

if command -v systemctl >/dev/null 2>&1; then
  for service in nginx.service postgresql.service kylesong-api.service kylesong-outbox.service; do
    show_unit "$service"
  done
  # Distribution-specific PostgreSQL instances may use an additional unit.
  if capture systemctl list-unit-files --type=service --no-legend --no-pager; then
    postgres_units=$(printf '%s\n' "$captured" | awk '$1 ~ /^postgres(ql)?[A-Za-z0-9@_.-]*\.service$/ && $1 != "postgresql.service" && $1 !~ /@\.service$/ { print $1 }')
    for service in $postgres_units; do show_unit "$service"; done
  else
    issue 'PostgreSQL unit discovery unavailable'
  fi
else
  issue 'systemctl unavailable; service state and unit metadata not verified'
fi

show_command 'disk.root' df -hP /
if [ -d /opt ]; then show_command 'disk.opt' df -hP /opt; fi
if command -v free >/dev/null 2>&1; then
  show_command 'memory.MiB' free -m
elif [ -r /proc/meminfo ]; then
  show_command 'memory.kB' awk '/^(MemTotal|MemFree|MemAvailable|SwapTotal|SwapFree):/ {print}' /proc/meminfo
else
  issue 'Memory inventory unavailable'
fi
if command -v ss >/dev/null 2>&1; then
  show_command 'listeners.TCP_UDP' ss -H -lntu
elif command -v netstat >/dev/null 2>&1; then
  show_command 'listeners.TCP_UDP' netstat -lntu
else
  issue 'Listening-port inventory unavailable (ss/netstat missing)'
fi

for directory in /opt/kylesong /opt/kylesong/web /opt/duduhire /opt/duduhire/releases /opt/duduhire/current; do
  show_directory "$directory"
done
if [ -d /opt/duduhire/releases ] && [ -r /opt/duduhire/releases ] && [ -x /opt/duduhire/releases ]; then
  # Names only; do not read existing release files or any environment files.
  for release in /opt/duduhire/releases/*; do
    if [ -e "$release" ] || [ -L "$release" ]; then
      printf 'existing.release.entry=%s\n' "${release##*/}"
    fi
  done
fi

sql="SELECT 'postgres.' || name || '=' || setting AS inventory
FROM pg_settings
WHERE name IN ('server_version','ssl','ssl_cert_file','ssl_key_file','listen_addresses','port','hba_file','config_file','data_directory')
UNION ALL
SELECT 'database.' || target.name || '.exists=' || EXISTS (SELECT 1 FROM pg_database WHERE datname=target.name)::text
FROM (VALUES ('zjad'), ('duduhire')) AS target(name)
UNION ALL
SELECT 'role.' || target.name || '.exists=' || EXISTS (SELECT 1 FROM pg_roles WHERE rolname=target.name)::text
FROM (VALUES ('duduhire_owner'), ('duduhire_runtime'), ('duduhire_maintenance'), ('duduhire_notifications')) AS target(name)
ORDER BY inventory;"

postgres_ok=false
if command -v psql >/dev/null 2>&1; then
  # Explicit local socket/port/database/user; inherited remote libpq settings and
  # saved password files cannot redirect this check or trigger password prompts.
  psql_path=$(command -v psql)
  for socket in /var/run/postgresql /run/postgresql /tmp; do
    [ -S "$socket/.s.PGSQL.5432" ] || continue
    if [ "$(id -u)" = 0 ] && command -v sudo >/dev/null 2>&1; then
      connection=(sudo -n -u postgres env -u PGSERVICE -u PGSERVICEFILE -u PGHOSTADDR -u PGPASSWORD)
    else
      connection=(env -u PGSERVICE -u PGSERVICEFILE -u PGHOSTADDR -u PGPASSWORD)
    fi
    if capture "${connection[@]}" PGCONNECT_TIMEOUT=3 PGPASSFILE=/dev/null \
      PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=2000' \
      "$psql_path" -X -w -q -A -t -v ON_ERROR_STOP=1 \
      -h "$socket" -p 5432 -U postgres -d postgres -c "$sql"; then
      setting_count=$(printf '%s\n' "$captured" | awk '/^postgres\./ {count++} END {print count+0}')
      existence_count=$(printf '%s\n' "$captured" | awk '/^(database|role)\..*\.exists=(true|false)$/ {count++} END {print count+0}')
      if [ "$setting_count" -eq 9 ] && [ "$existence_count" -eq 6 ]; then
        printf 'postgres.local_socket=%s\n%s\n' "$socket" "$captured"
        postgres_ok=true
        break
      fi
    fi
  done
fi
if [ "$postgres_ok" != true ]; then
  issue 'PostgreSQL settings/database/role inventory unavailable: local 5432 peer access not established; no password or remote connection attempted'
fi

printf 'summary.errors=%s\nsummary.warnings=%s\n' "$errors" "$warnings"
printf 'Retry boundary: existing DuduHire paths/databases/roles must be reconciled before installation; this script changes none.\n'
if [ "$errors" -gt 0 ]; then
  printf 'summary.result=INCOMPLETE (see ERROR entries; not a deployment pass)\n'
  exit 1
fi
printf 'summary.result=INVENTORY_COLLECTED (service states and warnings still require review; not a deployment pass)\n'
