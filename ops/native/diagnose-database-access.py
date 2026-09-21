#!/usr/bin/env python3
"""Read-only diagnosis of partially bootstrapped database access; Python 3.6+."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
from urllib.parse import unquote, urlsplit

sys.dont_write_bytecode = True
import bootstrap as b

ERRORS = (
    (r"password authentication failed", "password_authentication_failed"),
    (r"Ident authentication failed", "ident_authentication_failed"),
    (r"Peer authentication failed", "peer_authentication_failed"),
    (r"no pg_hba.conf entry", "no_matching_HBA_entry"),
    (r"pg_hba.conf rejects connection", "HBA_rejected_connection"),
    (r"authentication method 10 not supported|SCRAM authentication requires", "client_SCRAM_unsupported"),
    (r"no password supplied", "password_not_supplied"),
    (r"certificate verify failed|unable to get local issuer certificate", "TLS_chain_not_trusted"),
    (r"server certificate .* does not match host name|hostname mismatch", "TLS_hostname_mismatch"),
    (r"root certificate file .* does not exist", "TLS_root_certificate_missing"),
    (r"could not read root certificate file|could not load root certificate", "TLS_root_certificate_unreadable"),
    (r"server does not support SSL", "server_TLS_unavailable"),
    (r"permission denied for database", "database_connect_permission_denied"),
    (r"permission denied for (?:view|table|relation)", "query_relation_permission_denied"),
    (r"role .* does not exist", "role_missing"),
    (r"database .* does not exist", "database_missing"),
    (r"connection refused", "connection_refused"),
    (r"timeout expired|connection timed out|statement timeout", "connection_or_query_timeout"),
    (r"syntax error", "query_syntax_error"),
)
PROFILES = (
    ("migration", "MIGRATION_DATABASE_URL", "duduhire_owner"),
    ("runtime", "DATABASE_URL", "duduhire_runtime"),
    ("maintenance", "MAINTENANCE_DATABASE_URL", "duduhire_maintenance"),
)
SQL = "SELECT current_user || '|' || current_database() || '|' || (SELECT ssl::text FROM pg_stat_ssl WHERE pid=pg_backend_pid());"


def capture(command, environment=None):
    try:
        value = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, timeout=12, env=environment, check=False)
        return value.returncode, value.stdout, value.stderr
    except subprocess.TimeoutExpired:
        return 124, b"", b"timeout expired"
    except OSError:
        return 127, b"", b""


def classifications(raw):
    text = raw.decode("utf8", "replace")
    return sorted(set(label for pattern, label in ERRORS if re.search(pattern, text, re.I)))


def version(name):
    executable = shutil.which(name)
    if not executable:
        return {"available": False}
    code, output, _ = capture([executable, "--version"])
    match = re.fullmatch(rb"(?:psql|pg_dump) \(PostgreSQL\) [0-9A-Za-z.+~() _-]+\s*", output)
    return {"available": code == 0, "path": executable, "returncode": code,
            "version": output.decode("ascii").strip() if code == 0 and match else "unrecognized"}


def connection_environment(profile, url_key, expected_role):
    path = b.CONFIG / (profile + ".env")
    info = path.lstat()
    b.require(path.resolve() == path and stat.S_ISREG(info.st_mode) and info.st_uid == 0
              and stat.S_IMODE(info.st_mode) == 0o600 and info.st_size < 65536,
              "private_env_metadata_invalid")
    # Parse only the exact generated single-quote subset, without shell evaluation.
    values = {}
    for line in path.read_text().splitlines():
        match = re.fullmatch(r"([A-Z][A-Z0-9_]*)='([^'\\\r\n\x00]*)'", line)
        b.require(match is not None, "private_env_format_invalid")
        key, value = match.groups()
        if key in (url_key, "NODE_EXTRA_CA_CERTS"):
            b.require(key not in values, "private_env_duplicate_key")
            values[key] = value
    uri = urlsplit(values[url_key])
    b.require(uri.scheme == "postgresql" and uri.hostname in ("127.0.0.1", "localhost")
              and uri.port == 5432 and uri.path == "/duduhire" and uri.username == expected_role
              and not uri.query and not uri.fragment and re.fullmatch(r"[0-9a-f]{64}", uri.password or ""),
              "private_database_connection_shape_invalid")
    b.require(values["NODE_EXTRA_CA_CERTS"] == "/etc/duduhire/ca.crt", "private_CA_path_changed")
    return {"PATH": "/usr/bin:/bin", "LC_ALL": "C", "PGHOST": uri.hostname, "PGPORT": "5432",
            "PGDATABASE": "duduhire", "PGUSER": expected_role, "PGPASSWORD": unquote(uri.password),
            "PGSSLMODE": "verify-full", "PGSSLROOTCERT": values["NODE_EXTRA_CA_CERTS"],
            "PGCONNECT_TIMEOUT": "5", "PGPASSFILE": "/dev/null",
            "PGOPTIONS": "-c default_transaction_read_only=on -c statement_timeout=5000"}


def role_probe(profile, url_key, role, localhost_comparison=False):
    expected = role + "|duduhire|true"
    result = {"profile": profile, "expected": expected, "sslMode": "verify-full",
              "connectionVariant": "localhost_with_loopback_hostaddr" if localhost_comparison else "configured_host"}
    try:
        environment = connection_environment(profile, url_key, role)
        if localhost_comparison:
            # Isolate libpq hostname verification from the physical loopback endpoint.
            environment["PGHOST"] = "localhost"
            environment["PGHOSTADDR"] = "127.0.0.1"
        code, output, error = capture([shutil.which("psql") or "psql", "-X", "-w", "-qAt",
                                      "-v", "ON_ERROR_STOP=1", "-c", SQL], environment)
        observed = output.decode("utf8", "replace").strip()
        safe = re.fullmatch(r"duduhire_(?:owner|runtime|maintenance)\|duduhire\|(?:true|false|t|f)?", observed)
        result.update({"returncode": code, "errorClasses": classifications(error),
                       "observed": observed if safe else ("empty" if not observed else "unrecognized_redacted"),
                       "matchesExpected": code == 0 and observed == expected,
                       "unclassifiedFailure": code != 0 and not classifications(error)})
    except Exception as error:
        result.update({"available": False, "matchesExpected": False,
                       "errorClass": str(error) if isinstance(error, b.Stop) else type(error).__name__})
    return result


def metadata():
    # One SELECT: no psql multi-command last-result ambiguity. Never reads role verifiers.
    sql = """SELECT json_build_object(
      'settings',(SELECT json_object_agg(name,setting) FROM pg_settings WHERE name IN
        ('server_version','ssl','ssl_cert_file','ssl_key_file','port','listen_addresses','hba_file')),
      'roles',(SELECT json_agg(json_build_object('role',rolname,'login',rolcanlogin,'superuser',rolsuper,
        'createdb',rolcreatedb,'createrole',rolcreaterole,'replication',rolreplication,'bypassrls',rolbypassrls))
        FROM pg_roles WHERE rolname IN ('duduhire_owner','duduhire_runtime','duduhire_maintenance')),
      'database',(SELECT json_build_object('name',datname,'owner',pg_get_userbyid(datdba),
        'allowConnections',datallowconn) FROM pg_database WHERE datname='duduhire'),
      'connectPrivileges',(SELECT json_object_agg(rolname,has_database_privilege(oid,'duduhire','CONNECT'))
        FROM pg_roles WHERE rolname IN ('duduhire_owner','duduhire_runtime','duduhire_maintenance')),
      'hba',(SELECT json_agg(json_build_object('line',line_number,'type',type,'database',database,
        'users',user_name,'address',address,'netmask',netmask,'method',auth_method,'hasError',error IS NOT NULL))
        FROM pg_hba_file_rules))::text;"""
    return json.loads(b.query(sql))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backup", type=Path, required=True)
    args = parser.parse_args()
    b.require(sys.platform.startswith("linux") and os.geteuid() == 0, "target_Linux_root_required")
    target = b.selected_backup(str(args.backup))
    result = {"readOnly": True, "tools": {name: version(name) for name in ("psql", "pg_dump")},
              "note": "Probes use CURRENT restored HBA. Their results do not reconstruct the failed temporary HBA state."}
    try:
        result["postgres"] = metadata()
        hba = Path(result["postgres"]["settings"]["hba_file"])
        saved = target / "pg_hba.conf.before"
        result["hbaMatchesBackup"] = b.digest(hba) == b.digest(saved)
        result["hbaCurrentSHA256"] = b.digest(hba)
        result["hbaBackupSHA256"] = b.digest(saved)
    except Exception as error:
        result["metadataUnavailable"] = str(error) if isinstance(error, b.Stop) else type(error).__name__
    result["roles"] = [role_probe(*profile) for profile in PROFILES]
    result["localhostComparison"] = [role_probe(*profile, localhost_comparison=True) for profile in PROFILES]
    result["allExpectedConnectionsSucceeded"] = all(row["matchesExpected"] for row in result["roles"])
    result["boundary"] = "No database, role, HBA, environment or service changes; no reload, restart, plaintext probe or secret output."
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"readOnly": True, "diagnosisIncomplete": True,
              "errorClass": str(error) if isinstance(error, b.Stop) else type(error).__name__}), file=sys.stderr)
        sys.exit(1)
