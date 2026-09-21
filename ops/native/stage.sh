#!/usr/bin/env bash
# Reviewable, step-by-step staging ONLY. Default prints prerequisites.
# Does not provision PostgreSQL/TLS/accounts, alter nginx, or switch current.
set -euo pipefail
umask 077

fail() { printf 'ERROR %s\n' "$1" >&2; exit 1; }
usage() {
  cat <<'HELP'
Usage: bash stage.sh STEP RELEASE_ID [EXISTING_SERVICE_USER]
Steps, in order: dependencies, validate, migrate, unit, start, ready
Default/help: print this plan without touching the server.

Prerequisites (prepare/review separately before running a step):
  1. Back up the old deployment. Keep /opt/kylesong, zjad and nginx TLS unchanged.
  2. Verify a fresh release archive SHA256, safe paths and file manifest; extract
     into a new /opt/duduhire/releases/RELEASE_ID. Do not overwrite an old release.
  3. Prepare an existing dedicated non-root service user (default duduhire).
  4. Confirm PostgreSQL TLS and a CA certificate matching the connection hostname.
     Export non-secret DUDUHIRE_CA_FILE=/absolute/path/to/confirmed-ca.crt.
     The certificate must be readable by the service user; do not use a key file.
  5. Administrator provisions NEW database duduhire owned by duduhire_owner,
     plus independent duduhire_runtime and duduhire_maintenance login roles.
     Do not point any of these roles at zjad. Roles must have no elevated flags.
     Before migrations, revoke PUBLIC CONNECT/TEMPORARY on duduhire and CREATE
     on public; grant CONNECT to all three roles, USAGE to runtime/maintenance,
     and USAGE/CREATE to owner. Make owner own database and public schema.
  6. Provision root-owned, mode 0600, non-symlink files outside the release:
     /etc/duduhire/runtime.env, migration.env, maintenance.env.
     Runtime: NODE_ENV=production HOST=127.0.0.1 PORT=8788
       WEB_ORIGIN=https://kylesong.top DATABASE_URL=(runtime,new duduhire DB)
       DATABASE_SSL=true AUTH_COOKIE_SECURE=true
       AUTH_COOKIE_NAME=__Host-duduhire_session TRUST_PROXY_CIDRS=127.0.0.1/32
       AUTH_TOKEN_SECRET, CONTACT_DATA_KEY, CONTACT_DATA_KEY_ID: fresh real values
       AI_MODE=qwen plus real Qwen credentials/model; no local fallback
       EMAIL_DELIVERY_MODE=disabled OR smtp with real SMTP_URL and EMAIL_FROM
       PHONE_AUTH_ENABLED=false until credentials/allowlist/bounded test are ready
       NODE_EXTRA_CA_CERTS must equal DUDUHIRE_CA_FILE.
     Migration: NODE_ENV=production MIGRATION_DATABASE_SSL=true
       MIGRATION_DATABASE_URL=(owner,new duduhire DB), NODE_EXTRA_CA_CERTS.
     Maintenance: NODE_ENV=production MAINTENANCE_DATABASE_SSL=true
       MAINTENANCE_DATABASE_URL=(maintenance,new duduhire DB), NODE_EXTRA_CA_CERTS.
     No owner/maintenance/notification secrets may be in runtime.env.

dependencies installs Linux runtime dependencies into the NEW release only.
validate checks production configuration, real verified PostgreSQL TLS and roles.
migrate applies checksum-checked 001-011 migrations and the repository grant SQL;
  it then checks full migration checksums and runtime/maintenance privilege limits.
unit creates /etc/systemd/system/duduhire-api-staging.service only if absent;
  an identical existing unit is accepted, a different one is never overwritten.
start starts only that unit on 127.0.0.1:8788; no restart/enable or nginx reload.
ready checks local liveness/readiness/methods; this is NOT public acceptance.
No step creates a current symlink or starts the notification worker.
HELP
}

step=${1:-help}
case "$step" in help|--help) usage; exit 0;; esac
case "$step" in dependencies|validate|migrate|unit|start|ready) ;; *) fail 'Unknown step; use help';; esac
[ "$#" -ge 2 ] && [ "$#" -le 3 ] || fail 'Expected STEP RELEASE_ID [EXISTING_SERVICE_USER]'
release_id=$2
app_user=${3:-duduhire}
[[ "$release_id" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$ ]] || fail 'Unsafe release ID'
[[ "$app_user" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || fail 'Unsafe service user'
[ "$(uname -s)" = Linux ] || fail 'Execution is restricted to the target Linux server'
[ "$(id -u)" = 0 ] || fail 'Run the selected step as the already-authorized server administrator'
[ "$(id -u "$app_user")" -ne 0 ] || fail 'Dedicated non-root service user required'
release=/opt/duduhire/releases/$release_id
unit_path=/etc/systemd/system/duduhire-api-staging.service
for directory in /opt /opt/duduhire /opt/duduhire/releases "$release" /etc/duduhire; do
  [ -d "$directory" ] && [ ! -L "$directory" ] || fail "Required real directory missing: $directory"
done
for file in RELEASE.json SHA256SUMS package-lock.json apps/api/dist/server.js apps/api/dist/migrate.js apps/api/sql/grant-database-roles.sql; do
  [ -f "$release/$file" ] && [ ! -L "$release/$file" ] || fail "Required release file missing: $file"
done
node_path=$(command -v node) || fail 'Node unavailable'
[[ "$node_path" =~ ^/[A-Za-z0-9_./-]+$ ]] || fail 'Node binary path must be a plain absolute path'
"$node_path" -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<22||(a===22&&b<13))process.exit(1)' || fail 'Node >=22.13 required'

if [ "$step" = dependencies ]; then
  [ ! -e "$release/node_modules" ] && [ ! -L "$release/node_modules" ] || fail 'node_modules already exists; inspect the prior install instead of overwriting it'
  (cd "$release" && sha256sum --check --quiet SHA256SUMS) || fail 'Release payload checksum verification failed'
  command -v runuser >/dev/null || fail 'runuser unavailable'
  command -v npm >/dev/null || fail 'npm unavailable'
  # Public registry dependencies only. Installation gets no production secrets.
  # This release must already have passed safe archive extraction/path checks.
  chown -R "$app_user:$(id -gn "$app_user")" "$release"
  install -d -m 0700 -o "$app_user" -g "$(id -gn "$app_user")" "$release/.native-install"
  if ! runuser -u "$app_user" -- env -i \
    PATH="$(dirname "$node_path"):/usr/local/bin:/usr/bin:/bin" \
    HOME="$release/.native-install" npm_config_userconfig=/dev/null \
    npm_config_cache="$release/.native-install/cache" npm_config_logs_max=0 \
    npm_config_update_notifier=false /bin/sh -c \
    'umask 022; exec npm --prefix "$1" ci --omit=dev --workspace @duduhire/api --include-workspace-root --no-audit --no-fund' \
    duduhire-install "$release"; then
    chown -hR root:root "$release"
    fail 'Linux dependency installation failed; partial release retained for inspection'
  fi
  chown -hR root:root "$release"
  # Only public release files become readable; the install cache remains private.
  find "$release" -path "$release/.native-install" -prune -o -type d -exec chmod 0755 '{}' +
  find "$release" -path "$release/.native-install" -prune -o -type f -exec chmod a+r '{}' +
  if ! runuser -u "$app_user" -- env -i \
    PATH="$(dirname "$node_path"):/usr/local/bin:/usr/bin:/bin" HOME=/nonexistent \
    "$node_path" --input-type=module - "$release" <<'IMPORT'
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
try {
  const manifest=process.argv[2]+'/apps/api/package.json';
  const require=createRequire(manifest);
  for(const name of Object.keys(JSON.parse(readFileSync(manifest,'utf8')).dependencies)) {
    await import(pathToFileURL(require.resolve(name)));
  }
  console.log('Service user can read/import all API runtime dependencies; no provider calls made');
} catch { console.error('Dependency read/import failed under the service user'); process.exitCode=1; }
IMPORT
  then
    fail 'Service-user dependency import failed; keep staging offline and inspect this release'
  fi
  printf 'DONE dependencies (Linux install and service-user imports; actual API startup still required)\n'
  exit 0
fi

ca_file=${DUDUHIRE_CA_FILE:-}
[[ "$ca_file" =~ ^/[A-Za-z0-9_./-]+$ ]] && [ -f "$ca_file" ] && [ ! -L "$ca_file" ] || fail 'Set DUDUHIRE_CA_FILE to the confirmed readable CA certificate, not a key'
command -v runuser >/dev/null || fail 'runuser unavailable'
runuser -u "$app_user" -- test -r "$ca_file" || fail 'Service user cannot read the CA certificate'
command -v openssl >/dev/null || fail 'openssl unavailable for certificate format validation'
openssl x509 -in "$ca_file" -noout >/dev/null 2>&1 || fail 'CA input must be a readable X.509 certificate'

database_task() {
  # Values remain in process memory/private files. Never source .env as shell,
  # pass a database URL on argv, or forward provider/parser error messages.
  NODE_EXTRA_CA_CERTS="$ca_file" "$node_path" --input-type=module - "$1" "$release" "$ca_file" <<'NODE'
import { readFileSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const [mode, release, ca] = process.argv.slice(2);
let phase = 'environment';
const check = value => { if (!value) throw new Error('Requirement not satisfied'); };
try {
  const readEnv = name => {
    const path = `/etc/duduhire/${name}.env`;
    const stat = lstatSync(path);
    check(stat.isFile() && !stat.isSymbolicLink() && stat.uid === 0 && stat.nlink === 1
      && (stat.mode & 0o7777) === 0o600 && stat.size < 65536 && realpathSync(path) === path);
    const env = parseEnv(readFileSync(path, 'utf8'));
    check(env.NODE_ENV === 'production' && env.NODE_EXTRA_CA_CERTS === ca
      && env.NODE_OPTIONS === undefined && env.NODE_TLS_REJECT_UNAUTHORIZED === undefined
      && env.DUDUHIRE_LOAD_LOCAL_ENV === undefined);
    return env;
  };
  const runtime = readEnv('runtime');
  const migration = readEnv('migration');
  const maintenance = readEnv('maintenance');
  check(!['MIGRATION_DATABASE_URL','MAINTENANCE_DATABASE_URL','NOTIFICATION_DATABASE_URL','ROTATION_DATABASE_URL']
    .some(key => key in runtime));
  check(migration.MIGRATION_DATABASE_SSL === 'true' && maintenance.MAINTENANCE_DATABASE_SSL === 'true');
  const {loadConfig, loadDatabaseConfig} = await import(pathToFileURL(`${release}/apps/api/dist/config.js`));
  const config = loadConfig(runtime);
  check(config.host === '127.0.0.1' && config.port === 8788 && config.webOrigin === 'https://kylesong.top');
  check(config.trustProxy?.length === 1 && config.trustProxy[0] === '127.0.0.1/32');
  check(['smtp','disabled'].includes(config.emailDeliveryMode));
  const definitions = [
    ['duduhire_owner', migration.MIGRATION_DATABASE_URL],
    ['duduhire_runtime', runtime.DATABASE_URL],
    ['duduhire_maintenance', maintenance.MAINTENANCE_DATABASE_URL],
  ];
  const targets = definitions.map(([,raw]) => new URL(raw));
  check(targets.every(url => url.hostname === targets[0].hostname
    && (url.port || '5432') === (targets[0].port || '5432')));
  const {createDatabasePool} = await import(pathToFileURL(`${release}/apps/api/dist/postgresRepository.js`));
  const queryAs = async (role, raw, callback) => {
    const url = new URL(raw);
    check(decodeURIComponent(url.pathname) === '/duduhire' && decodeURIComponent(url.username) === role);
    loadDatabaseConfig({NODE_ENV:'production', DATABASE_URL:raw, DATABASE_SSL:'true'});
    const pool = createDatabasePool(raw, true, 'migration');
    try {
      const identity = await pool.query(`SELECT current_database() AS db, current_user AS usr,
        (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS tls,
        rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls AS elevated
        FROM pg_roles WHERE rolname=current_user`);
      check(identity.rows[0]?.db === 'duduhire' && identity.rows[0]?.usr === role
        && identity.rows[0]?.tls === true && identity.rows[0]?.elevated === false);
      return await callback(pool);
    } finally { await pool.end(); }
  };
  phase = 'verified_database_TLS_and_roles';
  for (const [role, raw] of definitions) await queryAs(role, raw, async pool => {
    if (role === 'duduhire_owner') {
      const ownership = await pool.query(`SELECT
        (SELECT pg_get_userbyid(datdba) = current_user FROM pg_database WHERE datname=current_database()) AS db_owner,
        (SELECT pg_get_userbyid(nspowner) = current_user FROM pg_namespace WHERE nspname='public') AS schema_owner`);
      check(ownership.rows[0]?.db_owner && ownership.rows[0]?.schema_owner);
    } else {
      const member = await pool.query("SELECT pg_has_role(current_user,'duduhire_owner','MEMBER') AS owner_member");
      check(member.rows[0]?.owner_member === false);
    }
  });
  if (mode === 'migrate') {
    phase = 'migrations';
    const applied = spawnSync(process.execPath, [`${release}/apps/api/dist/migrate.js`], {
      cwd:release, env:{PATH:process.env.PATH, ...migration}, stdio:'ignore', timeout:120000,
    });
    check(applied.status === 0);
    phase = 'grant_database_roles';
    const owner = new URL(migration.MIGRATION_DATABASE_URL);
    const grant = spawnSync('psql', ['-X','-w','-q','-v','ON_ERROR_STOP=1',
      '-v','database_name=duduhire','-v','runtime_role=duduhire_runtime',
      '-v','maintenance_role=duduhire_maintenance','-f',`${release}/apps/api/sql/grant-database-roles.sql`], {
      env:{PATH:process.env.PATH, PGHOST:owner.hostname, PGPORT:owner.port || '5432',
        PGDATABASE:'duduhire', PGUSER:'duduhire_owner', PGPASSWORD:decodeURIComponent(owner.password),
        PGSSLMODE:'verify-full', PGSSLROOTCERT:ca, PGCONNECT_TIMEOUT:'5',
        PGOPTIONS:'-c statement_timeout=30000 -c lock_timeout=5000', PGPASSFILE:'/dev/null'},
      stdio:'ignore', timeout:60000,
    });
    check(grant.status === 0);
  }
  if (mode === 'migrate' || mode === 'post-migration') {
    phase = 'migration_checksums_and_privileges';
    await queryAs(...definitions[0], async pool => {
      const names = readdirSync(`${release}/apps/api/migrations`).filter(name => /^\d+.*\.sql$/.test(name)).sort();
      check(names.length === 11 && names[10] === '011_session_active_role.sql');
      const rows = (await pool.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows;
      check(rows.length === names.length);
      for (let i=0; i<names.length; i++) check(rows[i].name === names[i] && rows[i].checksum ===
        createHash('sha256').update(readFileSync(`${release}/apps/api/migrations/${names[i]}`)).digest('hex'));
    });
    for (const [role, raw] of definitions.slice(1)) await queryAs(role, raw, async pool => {
      const p = (await pool.query(`SELECT has_schema_privilege(current_user,'public','CREATE') AS ddl,
        has_database_privilege(current_user,current_database(),'TEMPORARY') AS temporary,
        has_table_privilege(current_user,'users','DELETE') AS deletes,
        has_table_privilege(current_user,'users','SELECT') AS reads,
        has_function_privilege(current_user,'public.run_data_retention_cleanup()','EXECUTE') AS cleanup`)).rows[0];
      check(!p.ddl && !p.temporary && !p.deletes);
      check(role === 'duduhire_runtime' ? p.reads && !p.cleanup : !p.reads && p.cleanup);
    });
  }
  process.stdout.write(`DONE ${mode}; production config, TLS and independent identities verified; no secrets printed\n`);
} catch {
  process.stderr.write(`ERROR staging requirement failed at ${phase}; values and raw provider errors suppressed\n`);
  process.exitCode=1;
}
NODE
}

if [ "$step" = validate ] || [ "$step" = migrate ]; then
  database_task "$step"
  exit 0
fi
database_task post-migration

render_unit() {
  cat <<UNIT
[Unit]
Description=DuduHire API staging on loopback 8788 ($release_id)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$app_user
Group=$(id -gn "$app_user")
WorkingDirectory=$release
EnvironmentFile=/etc/duduhire/runtime.env
ExecStart=$node_path $release/apps/api/dist/server.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=15
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
CapabilityBoundingSet=
AmbientCapabilities=
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
UMask=0077
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT
}

if [ "$step" = unit ]; then
  if [ -e "$unit_path" ] || [ -L "$unit_path" ]; then
    [ -f "$unit_path" ] && [ ! -L "$unit_path" ] && cmp -s "$unit_path" <(render_unit) || fail 'Existing staging unit differs; inspect before changing it'
  else
    (set -o noclobber; render_unit > "$unit_path") || fail 'Unit creation collision'
    chmod 0644 "$unit_path"
  fi
  printf 'DONE unit prepared; not loaded or started\n'
  exit 0
fi

[ -f "$unit_path" ] && [ ! -L "$unit_path" ] && cmp -s "$unit_path" <(render_unit) || fail 'Staging unit is missing or does not match this release/user'
if [ "$step" = start ]; then
  command -v ss >/dev/null || fail 'ss required to verify port 8788 is unused'
  listeners=$(ss -H -ltn 'sport = :8788') || fail 'Could not inspect port 8788'
  [ -z "$listeners" ] || fail 'Port 8788 already occupied; inspect existing process instead of restarting it'
  systemctl daemon-reload
  systemctl start duduhire-api-staging.service || fail 'Staging service start failed; nginx and old service remain unchanged'
fi

systemctl is-active --quiet duduhire-api-staging.service || fail 'Staging service is not active'
"$node_path" --input-type=module <<'READY'
try {
  let healthy=false;
  const deadline=Date.now()+30000;
  while(!healthy && Date.now()<deadline) {
    try {
      for (const [path,expected] of [['/api/health/live','ok'],['/api/health/ready','ready']]) {
        const response=await fetch(`http://127.0.0.1:8788${path}`,{signal:AbortSignal.timeout(2000)});
        if(!response.ok || (await response.json()).status!==expected) throw new Error();
      }
      healthy=true;
    } catch { await new Promise(resolve=>setTimeout(resolve,500)); }
  }
  if(!healthy) throw new Error();
  const response=await fetch('http://127.0.0.1:8788/api/v1/auth/methods',{signal:AbortSignal.timeout(5000)});
  if(!response.ok) throw new Error();
  const methods=await response.json();
  if(typeof methods.email?.available!=='boolean' || typeof methods.phone?.available!=='boolean') throw new Error();
  console.log(JSON.stringify({localReady:true,emailAvailable:methods.email?.available,phoneAvailable:methods.phone?.available}));
} catch { console.error('ERROR local readiness failed; this does not alter or roll back nginx'); process.exitCode=1; }
READY
printf 'DONE staging only; public cutover, real Qwen, SMS and any enabled SMTP acceptance remain pending\n'
