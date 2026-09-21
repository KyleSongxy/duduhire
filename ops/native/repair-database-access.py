#!/usr/bin/env python3
"""Reconcile the known libpq 13 IP-name mismatch without recreating the database.

Python 3.6+, run beside the original reviewed bootstrap.py. Existing credentials,
provider limits, old-site backup and original HBA backup are preserved.
"""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import sys
import time

sys.dont_write_bytecode = True
import bootstrap as b

PROFILES = (("migration", "MIGRATION_DATABASE_URL", "duduhire_owner"),
            ("runtime", "DATABASE_URL", "duduhire_runtime"),
            ("maintenance", "MAINTENANCE_DATABASE_URL", "duduhire_maintenance"))
PROBE_SQL = "SELECT current_user || '|' || current_database() || '|' || (SELECT ssl::text FROM pg_stat_ssl WHERE pid=pg_backend_pid());"
RULES = ("# BEGIN DUDUHIRE - only the new database; existing databases unchanged\n"
         "local duduhire all reject\n"
         "hostnossl duduhire all 0.0.0.0/0 reject\n"
         "hostnossl duduhire all ::/0 reject\n"
         "hostssl duduhire duduhire_owner,duduhire_runtime,duduhire_maintenance 127.0.0.1/32 scram-sha-256\n"
         "hostssl duduhire all 0.0.0.0/0 reject\n"
         "hostssl duduhire all ::/0 reject\n"
         "# END DUDUHIRE\n").encode()


def regular(path, private=False):
    info = path.lstat()
    b.require(stat.S_ISREG(info.st_mode) and path.resolve() == path and info.st_nlink == 1,
              "regular_file_without_symlink_required")
    if private:
        b.require(info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o600 and info.st_size < 65536,
                  "private_file_metadata_invalid")
    return info


def replace(path, content, info):
    temporary = path.parent / (path.name + ".database-repair-" + secrets.token_hex(4))
    try:
        b.new_file(temporary, content, stat.S_IMODE(info.st_mode), info.st_uid, info.st_gid)
        os.replace(str(temporary), str(path))
    finally:
        if temporary.exists():
            temporary.unlink()


def parse_env(raw):
    values = {}
    for line in raw.decode("utf8").splitlines():
        match = re.fullmatch(r"([A-Z][A-Z0-9_]*)='([^'\\\r\n\x00]*)'", line)
        b.require(match is not None, "generated_env_format_changed")
        key, value = match.groups()
        b.require(key not in values, "duplicate_env_key")
        values[key] = value
    return values


def role_environment(role, password, ca, tls=True):
    return {"PATH": "/usr/bin:/bin", "LC_ALL": "C", "PGHOST": "localhost", "PGHOSTADDR": "127.0.0.1",
            "PGPORT": "5432", "PGDATABASE": "duduhire", "PGUSER": role, "PGPASSWORD": password,
            "PGSSLMODE": "verify-full" if tls else "disable", "PGSSLROOTCERT": str(ca),
            "PGCONNECT_TIMEOUT": "5", "PGPASSFILE": "/dev/null",
            "PGOPTIONS": "-c default_transaction_read_only=on -c statement_timeout=5000"}


def verify_roles(passwords, ca):
    executable = b.shutil.which("psql")
    b.require(executable is not None, "psql_unavailable")
    for role in b.ROLES:
        b.phase("database_repair_verify_" + role)
        result = b.run([executable, "-X", "-w", "-qAt", "-v", "ON_ERROR_STOP=1", "-c", PROBE_SQL],
                       environment=role_environment(role, passwords[role], ca)).decode().strip()
        b.require(result == role + "|duduhire|true", "role_database_TLS_result_mismatch")
        denied = subprocess.run([executable, "-X", "-w", "-qAt", "-c", "SELECT 1;"],
            env=role_environment(role, passwords[role], ca, False), stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=12, check=False)
        b.require(denied.returncode != 0 and b"pg_hba.conf rejects connection" in denied.stderr,
                  "new_database_plaintext_HBA_rejection_not_confirmed")
        print("role=" + role + "; verified_tls=true; plaintext_rejected=true", flush=True)


def repair(backup):
    b.phase("database_repair_inspect_partial_state")
    target = b.selected_backup(str(backup))
    marker = target / "database-env-complete.json"
    b.require(not marker.exists() and not marker.is_symlink(), "database_env_already_completed_review_before_retry")
    inventory = b.inventory()
    b.require("zjad" in inventory["databases"] and "duduhire" in inventory["databases"]
              and set(inventory["roles"]) == set(b.ROLES), "expected_partial_database_roles_not_present")
    settings = inventory["settings"]
    b.require(settings["ssl"] == "on", "verified_server_TLS_required")
    role_state = json.loads(b.query("""SELECT json_build_object(
      'owner',(SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname='duduhire'),
      'rolesSafe',(SELECT count(*) FROM pg_roles WHERE rolname IN
        ('duduhire_owner','duduhire_runtime','duduhire_maintenance') AND rolcanlogin
        AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls))::text;"""))
    b.require(role_state == {"owner": "duduhire_owner", "rolesSafe": 3}, "database_owner_or_role_flags_changed")
    sql = """SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'
      AND c.relkind IN ('r','p','v','m','S','f');"""
    count = b.run(b.pg_command("psql", ["-X", "-w", "-qAt", "-d", "duduhire", "-c", sql])).decode().strip()
    b.require(count == "0", "new_database_already_has_application_objects")
    hba = Path(settings["hba_file"])
    hba_info = regular(hba)
    original_hba = hba.read_bytes()
    saved_hba = target / "pg_hba.conf.before"
    regular(saved_hba, True)
    b.require(original_hba == saved_hba.read_bytes() and b"BEGIN DUDUHIRE" not in original_hba,
              "HBA_not_equal_to_original_backup")
    b.require(b.query("SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL;") == "0",
              "existing_HBA_parse_errors")
    tls_path = target / "tls-complete.json"
    tls_info = regular(tls_path, True)
    original_tls = tls_path.read_bytes()
    tls_state = json.loads(original_tls.decode())
    b.require(tls_state["host"] == "127.0.0.1" and tls_state["port"] == 5432
              and tls_state["ca"] == "/etc/duduhire/ca.crt"
              and tls_state["verified"] == "local certificate-verified TLS handshake",
              "expected_TLS_marker_changed")
    ca = Path(tls_state["ca"])
    b.require(b.digest(ca) == tls_state["caSha256"], "verified_CA_changed")
    b.tls_probe(ca, "localhost", 5432)
    originals, file_info, replacements, passwords, profiles = {}, {}, {}, {}, {}
    for profile, url_key, role in PROFILES:
        path = b.CONFIG / (profile + ".env")
        file_info[path] = regular(path, True)
        raw = path.read_bytes()
        values = parse_env(raw)
        b.require(values.get("NODE_EXTRA_CA_CERTS") == str(ca), "env_CA_path_changed")
        url = values[url_key]
        match = re.fullmatch(r"postgresql://" + role + r":([0-9a-f]{64})@127\.0\.0\.1:5432/duduhire", url)
        b.require(match is not None, "expected_initial_database_URL_changed")
        passwords[role] = match.group(1)
        updated = url.replace("@127.0.0.1:5432/duduhire", "@localhost:5432/duduhire")
        old_line, new_line = url_key + "='" + url + "'", url_key + "='" + updated + "'"
        changed = raw.replace(old_line.encode(), new_line.encode())
        changed_values = parse_env(changed)
        b.require(changed_values == dict(values, **{url_key: updated}), "unrelated_env_value_changed")
        originals[path], replacements[path], profiles[profile] = raw, changed, values
    runtime = profiles["runtime"]
    b.require(runtime.get("EMAIL_DELIVERY_MODE") == "disabled" and runtime.get("PHONE_AUTH_ENABLED") == "true"
              and all(runtime.get(key) == "2" for key in
                      ("PHONE_AUTH_DAILY_LIMIT", "PHONE_AUTH_PHONE_HOURLY_LIMIT", "PHONE_AUTH_IP_HOURLY_LIMIT")),
              "original_provider_limits_changed")
    deadline = runtime["PHONE_AUTH_SEND_UNTIL"]
    expires = dt.datetime.strptime(deadline, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)
    now = dt.datetime.now(dt.timezone.utc)
    b.require(now < expires <= now + dt.timedelta(hours=24), "original_phone_authorization_deadline_expired_or_invalid")
    identifier = now.strftime("%Y%m%dT%H%M%SZ-") + secrets.token_hex(3)
    attempt = target / ("database-repair-" + identifier)
    b.directory(attempt, 0o700)
    for path, content in originals.items():
        b.new_file(attempt / (path.name + ".before"), content)
    b.new_file(attempt / "pg_hba.conf.before", original_hba)
    b.new_file(attempt / "tls-complete.json.before", original_tls)
    b.require(hba.read_bytes() == original_hba and tls_path.read_bytes() == original_tls
              and all(path.read_bytes() == raw for path, raw in originals.items()),
              "repair_inputs_changed_before_mutation")
    b.phase("database_repair_update_host_and_new_database_HBA")
    try:
        for path, content in replacements.items():
            replace(path, content, file_info[path])
        tls_state["host"] = "localhost"
        replace(tls_path, (json.dumps(tls_state, indent=2, sort_keys=True) + "\n").encode(), tls_info)
        replace(hba, RULES + original_hba, hba_info)
        b.require(b.query("SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL;") == "0",
                  "new_HBA_parse_errors")
        b.require(b.query("SELECT pg_reload_conf();") == "t", "new_HBA_reload_not_accepted")
        time.sleep(0.5)
        verify_roles(passwords, ca)
        b.require(hba.read_bytes() == RULES + original_hba and b.inventory()["settings"]["ssl"] == "on"
                  and all(path.read_bytes() == raw for path, raw in replacements.items()),
                  "repaired_state_changed_during_verification")
        b.write_json(marker, {"database": "duduhire", "roles": list(b.ROLES), "apiPort": 8788,
            "email": "disabled", "phoneDailyLimit": int(runtime["PHONE_AUTH_DAILY_LIMIT"]),
            "phoneSendUntil": deadline,
            "hba": "three roles verified over TLS/SCRAM; new database plaintext rejected; old HBA retained verbatim after new rules",
            "stage": "bootstrap prepared; application migrations, grants and runtime acceptance pending",
            "repairDirectory": str(attempt)})
    except Exception:
        b.phase("database_repair_restore_original_HBA_env_and_TLS_marker")
        replace(hba, original_hba, hba_info)
        for path, content in originals.items():
            replace(path, content, file_info[path])
        replace(tls_path, original_tls, tls_info)
        b.require(b.query("SELECT pg_reload_conf();") == "t", "repair_HBA_restore_reload_failed_manual_attention_required")
        b.require(hba.read_bytes() == original_hba and tls_path.read_bytes() == original_tls
                  and all(path.read_bytes() == raw for path, raw in originals.items()),
                  "repair_restore_not_confirmed_manual_attention_required")
        if marker.exists():
            marker.unlink()
        raise b.Stop("database_repair_failed_original_HBA_env_TLS_marker_restored_database_preserved")
    print("database_env_prepared=true; existing_credentials_preserved=true; postgres_restarted=false")
    print("database_repair_directory=" + str(attempt))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backup", type=Path, required=True)
    args = parser.parse_args()
    b.require(sys.platform.startswith("linux") and os.geteuid() == 0, "target_Linux_root_required")
    os.umask(0o077)
    repair(args.backup)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("phase=" + b.PHASE + "; failed=true; reason=" +
              (str(error) if isinstance(error, b.Stop) else type(error).__name__), file=sys.stderr)
        sys.exit(1)
