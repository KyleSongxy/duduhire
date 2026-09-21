#!/usr/bin/env python3
"""Reviewed steps only: backup, TLS, database/env. Never switches nginx or current."""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import secrets
import shutil
import socket
import ssl
import stat
import struct
import subprocess
import sys
import tarfile
import time

PHASE = "arguments"
BASE = Path("/root/duduhire-backups")
CONFIG = Path("/etc/duduhire")
ROLES = ("duduhire_owner", "duduhire_runtime", "duduhire_maintenance")


class Stop(Exception):
    pass


def require(ok, message):
    if not ok:
        raise Stop(message)


def phase(name):
    global PHASE
    PHASE = name
    print("phase=" + name, flush=True)


def run(args, data=None, timeout=60, output=None, environment=None):
    # Never expose raw command arguments, stderr, SQL, or provider values.
    result = subprocess.run(args, input=data, stdout=output or subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=timeout, check=False, env=environment)
    require(result.returncode == 0, "command_failed:" + Path(args[0]).name)
    return result.stdout or b""


def pg_command(program, extra):
    binary = shutil.which(program)
    require(binary is not None, "required_PostgreSQL_tool_unavailable")
    options = ("-c statement_timeout=30000 -c lock_timeout=5000 "
               "-c log_statement=none -c log_min_duration_statement=-1 "
               "-c log_min_duration_sample=-1 -c log_min_error_statement=panic")
    return ["sudo", "-n", "-u", "postgres", "env", "-i", "PATH=/usr/bin:/bin",
            "PGCONNECT_TIMEOUT=5", "PGOPTIONS=" + options, binary] + extra


def query(sql):
    # psql -c exposes only the last result: inventory uses exactly ONE SELECT.
    require(sql.count(";") <= 1, "query_must_be_one_statement")
    return run(pg_command("psql", ["-X", "-w", "-qAt", "-d", "postgres", "-c", sql])).decode().strip()


def execute(sql, database="postgres"):
    # SQL containing role password verifiers travels over stdin, never argv.
    run(pg_command("psql", ["-X", "-w", "-q", "-v", "ON_ERROR_STOP=1", "-d", database, "-f", "-"]), sql.encode())


def inventory():
    result = json.loads(query("""SELECT json_build_object(
      'settings',(SELECT json_object_agg(name,setting) FROM pg_settings WHERE name IN
        ('server_version','ssl','ssl_cert_file','ssl_key_file','port','listen_addresses',
         'unix_socket_directories','hba_file','config_file','data_directory')),
      'databases',(SELECT coalesce(json_agg(datname),'[]'::json) FROM pg_database WHERE datname IN ('zjad','duduhire')),
      'roles',(SELECT coalesce(json_agg(rolname),'[]'::json) FROM pg_roles WHERE rolname IN
        ('duduhire_owner','duduhire_runtime','duduhire_maintenance')))::text;"""))
    settings = result["settings"]
    require(settings["server_version"].startswith("13.") and settings["port"] == "5432"
            and settings["listen_addresses"] == "127.0.0.1"
            and settings["data_directory"] == "/var/lib/pgsql/data"
            and settings["config_file"] == "/var/lib/pgsql/data/postgresql.conf"
            and settings["hba_file"] == "/var/lib/pgsql/data/pg_hba.conf", "observed_PostgreSQL_target_changed_review_before_mutation")
    return result


def directory(path, mode, uid=0, gid=0):
    if path.exists() or path.is_symlink():
        info = path.lstat()
        require(stat.S_ISDIR(info.st_mode) and not path.is_symlink() and info.st_uid == uid,
                "existing_directory_requires_review")
    else:
        path.mkdir(mode=mode)
        os.chmod(path, mode)
        os.chown(path, uid, gid)
    require(path.resolve() == path, "symlinked_directory_requires_review")


def new_file(path, content, mode=0o600, uid=0, gid=0):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(content if isinstance(content, bytes) else content.encode())
        stream.flush()
        os.fsync(stream.fileno())
    os.chmod(path, mode)
    os.chown(path, uid, gid)


def write_json(path, value):
    new_file(path, json.dumps(value, indent=2, sort_keys=True) + "\n")


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def selected_backup(raw):
    path = Path(raw)
    require(path.parent == BASE and path.resolve() == path and path.is_dir(), "invalid_backup_directory")
    require(path.stat().st_uid == 0 and stat.S_IMODE(path.stat().st_mode) == 0o700, "backup_permissions_invalid")
    require((path / "backup-complete.json").is_file(), "verified_backup_required")
    return path


def backup(_args):
    phase("backup_inventory")
    info = inventory()
    require("zjad" in info["databases"], "old_zjad_database_not_found")
    directory(BASE, 0o700)
    require(stat.S_IMODE(BASE.stat().st_mode) == 0o700, "backup_parent_must_be_0700")
    identifier = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ-") + secrets.token_hex(3)
    target = BASE / identifier
    target.mkdir(mode=0o700)
    sources = [Path(p) for p in ("/opt/kylesong", "/var/www/kylesong", "/etc/kylesong", "/etc/nginx")]
    for name in ("kylesong-api.service", "kylesong-outbox.service"):
        raw = run(["systemctl", "show", name, "--property=FragmentPath", "--value"]).decode().strip()
        require(raw.startswith("/") and Path(raw).is_file(), "old_service_unit_missing")
        sources.append(Path(raw))
        dropins = Path(raw + ".d")
        if dropins.is_dir():
            sources.append(dropins)
    missing = [str(path) for path in sources if not path.exists()]
    require(not missing, "expected_old_deployment_path_missing_review_inventory")
    phase("backup_files")
    archive = target / "old-deployment.tar.gz"
    with tarfile.open(archive, "x:gz", dereference=False) as tar:
        for source in sources:
            tar.add(str(source), arcname=str(source).lstrip("/"), recursive=True)
    os.chmod(archive, 0o600)
    phase("backup_database")
    dump = target / "zjad.dump"
    with dump.open("xb") as stream:
        run(pg_command("pg_dump", ["--format=custom", "--no-password", "--dbname=zjad"]),
            timeout=1800, output=stream)
    os.chmod(dump, 0o600)
    listing = run([shutil.which("pg_restore") or "pg_restore", "--list", str(dump)], timeout=120)
    require(bool(listing.strip()), "database_archive_listing_empty")
    new_file(target / "zjad-restore-list.txt", listing)
    phase("backup_verify_manifest")
    entries = []
    with tarfile.open(archive, "r:gz") as tar:
        for member in tar:
            require(not member.name.startswith("/") and ".." not in Path(member.name).parts,
                    "unsafe_backup_member_path")
            entry = {"path": member.name, "size": member.size, "type": member.type.decode("ascii")}
            if member.isfile():
                value = hashlib.sha256()
                with tar.extractfile(member) as stream:
                    for block in iter(lambda: stream.read(1024 * 1024), b""):
                        value.update(block)
                entry["sha256"] = value.hexdigest()
            entries.append(entry)
    files = {name: {"sha256": digest(target / name), "bytes": (target / name).stat().st_size}
             for name in (archive.name, dump.name, "zjad-restore-list.txt")}
    write_json(target / "backup-manifest.json", {"files": files, "archiveEntries": entries,
                                                "sourcePaths": [str(p) for p in sources]})
    write_json(target / "backup-complete.json", {"id": identifier, "inventory": info,
               "manifestSha256": digest(target / "backup-manifest.json"),
               "validation": "archive fully read; member hashes recorded; pg_restore --list passed; restore not executed"})
    print("backup_directory=" + str(target))
    print("backup_manifest_sha256=" + digest(target / "backup-manifest.json"))


def tls_probe(ca, host, port):
    context = ssl.create_default_context(cafile=str(ca))
    with socket.create_connection(("127.0.0.1", port), timeout=5) as connection:
        connection.sendall(struct.pack("!II", 8, 80877103))
        require(connection.recv(1) == b"S", "PostgreSQL_did_not_accept_TLS")
        with context.wrap_socket(connection, server_hostname=host) as secured:
            require(bool(secured.getpeercert()), "PostgreSQL_certificate_validation_failed")


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def tls(args):
    target = selected_backup(args.backup)
    require(not (target / "tls-complete.json").exists(), "TLS_step_already_completed_review_before_retry")
    info = inventory()["settings"]
    port = int(info["port"])
    require(port == 5432, "unexpected_PostgreSQL_port")
    directory(CONFIG, 0o755)
    require(stat.S_IMODE(CONFIG.stat().st_mode) == 0o755, "config_directory_must_be_0755_for_public_CA")
    ca = CONFIG / "ca.crt"
    phase("tls_inspect")
    if info["ssl"] == "on":
        require(args.ca is not None, "existing_TLS_preserved_supply_the_verified_CA")
        source = Path(args.ca).resolve(strict=True)
        run(["openssl", "x509", "-in", str(source), "-noout"])
        tls_probe(source, args.host, port)
        if ca.exists():
            require(not ca.is_symlink() and digest(ca) == digest(source), "existing_public_CA_differs")
        else:
            new_file(ca, source.read_bytes(), 0o644)
        source_mode = "existing_postgresql_certificate_preserved"
    else:
        require(info["ssl"] == "off" and not ca.exists(), "SSL_state_or_existing_CA_requires_review")
        postgres = pwd.getpwnam("postgres")
        data = Path(info["data_directory"])
        require(data.is_dir() and data.resolve() == data, "data_directory_requires_review")
        server = data / "duduhire-tls"
        require(not server.exists(), "existing_server_TLS_directory_requires_review")
        server.mkdir(mode=0o700)
        os.chown(server, postgres.pw_uid, postgres.pw_gid)
        private = target / "private-ca"
        private.mkdir(mode=0o700)
        auto = data / "postgresql.auto.conf"
        require(not auto.is_symlink(), "auto_conf_symlink_requires_review")
        original = auto.read_bytes() if auto.exists() else None
        original_stat = auto.stat() if auto.exists() else None
        if original is not None:
            new_file(target / "postgresql.auto.conf.before", original)
        write_json(target / "postgresql-auto-before.json", {"existed": original is not None,
                   "path": str(auto), "settings": info})
        phase("tls_generate_isolated_certificates")
        # OpenSSL 1.1.1 appends -addext to default v3_ca extensions, producing duplicates.
        # Select explicit isolated sections once for both the CA and the server request.
        new_file(private / "ca.cnf", "[req]\ndistinguished_name=dn\nprompt=no\nx509_extensions=ca\n"
                 "[dn]\nCN=DuduHire PostgreSQL Private CA\n[ca]\nbasicConstraints=critical,CA:TRUE\n"
                 "keyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always\n")
        new_file(private / "server-csr.cnf", "[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=localhost\n")
        run(["openssl", "req", "-x509", "-newkey", "rsa:3072", "-nodes", "-days", "3650", "-sha256",
             "-keyout", str(private / "ca.key"), "-out", str(private / "ca.crt"),
             "-config", str(private / "ca.cnf"), "-extensions", "ca"])
        run(["openssl", "req", "-new", "-newkey", "rsa:3072", "-nodes", "-keyout", str(server / "server.key"),
             "-out", str(private / "server.csr"), "-sha256", "-config", str(private / "server-csr.cnf")])
        new_file(private / "server.ext", "[server]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n"
                 "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n"
                 "extendedKeyUsage=serverAuth\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always\n")
        run(["openssl", "x509", "-req", "-in", str(private / "server.csr"), "-CA", str(private / "ca.crt"),
             "-CAkey", str(private / "ca.key"), "-CAcreateserial", "-out", str(server / "server.crt"),
             "-days", "825", "-sha256", "-extfile", str(private / "server.ext"), "-extensions", "server"])
        phase("tls_verify_candidate_certificates_before_configuration")
        run(["openssl", "verify", "-check_ss_sig", "-CAfile", str(private / "ca.crt"), str(private / "ca.crt")])
        for option, name in (("-verify_hostname", "localhost"), ("-verify_ip", "127.0.0.1")):
            run(["openssl", "verify", "-CAfile", str(private / "ca.crt"), "-purpose", "sslserver",
                 option, name, str(server / "server.crt")])
        for name in ("server.key", "server.crt"):
            os.chmod(server / name, 0o600)
            os.chown(server / name, postgres.pw_uid, postgres.pw_gid)
        new_file(ca, (private / "ca.crt").read_bytes(), 0o644)
        phase("tls_configure_and_reload")
        try:
            execute("ALTER SYSTEM SET ssl_cert_file=" + literal(str(server / "server.crt")) + ";\n"
                    "ALTER SYSTEM SET ssl_key_file=" + literal(str(server / "server.key")) + ";\n"
                    "ALTER SYSTEM SET ssl='on';\n")
            require(query("SELECT pg_reload_conf();") == "t", "PostgreSQL_reload_not_accepted")
            for attempt in range(12):
                try:
                    require(inventory()["settings"]["ssl"] == "on", "TLS_reload_pending")
                    tls_probe(ca, args.host, port)
                    break
                except (Stop, OSError, ssl.SSLError):
                    if attempt == 11:
                        raise
                    time.sleep(0.5)
        except Exception:
            phase("tls_restore_original_auto_conf")
            if original is None:
                if auto.exists():
                    auto.unlink()
            else:
                replacement = data / ("postgresql.auto.conf.restore-" + secrets.token_hex(4))
                new_file(replacement, original, stat.S_IMODE(original_stat.st_mode), original_stat.st_uid, original_stat.st_gid)
                os.replace(replacement, auto)
            require(query("SELECT pg_reload_conf();") == "t", "TLS_restore_reload_failed_manual_attention_required")
            for attempt in range(12):
                if inventory()["settings"]["ssl"] == info["ssl"]:
                    break
                time.sleep(0.5)
            require(inventory()["settings"]["ssl"] == info["ssl"], "TLS_restore_not_confirmed_manual_attention_required")
            raise Stop("TLS_enable_failed_original_configuration_restored_no_restart")
        source_mode = "isolated_CA_and_server_certificate_created"
    write_json(target / "tls-complete.json", {"ca": str(ca), "caSha256": digest(ca),
               "host": args.host, "port": port, "mode": source_mode, "verified": "local certificate-verified TLS handshake"})
    print("tls_verified=true; postgres_restarted=false")


def scram(password):
    # Only the SCRAM verifier enters DDL; the plaintext stays in root-only env files.
    import base64
    import hmac
    salt = secrets.token_bytes(16)
    salted = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 4096)
    client = hmac.new(salted, b"Client Key", hashlib.sha256).digest()
    stored = hashlib.sha256(client).digest()
    server = hmac.new(salted, b"Server Key", hashlib.sha256).digest()
    b64 = lambda value: base64.b64encode(value).decode()
    return "SCRAM-SHA-256$4096:" + b64(salt) + "$" + b64(stored) + ":" + b64(server)


def restrict_new_database_hba(target, settings, tls_state, passwords):
    phase("new_database_HBA_backup")
    hba = Path(settings["hba_file"])
    original_stat = hba.lstat()
    require(stat.S_ISREG(original_stat.st_mode) and not hba.is_symlink(), "HBA_file_requires_review")
    original = hba.read_bytes()
    require(b"BEGIN DUDUHIRE" not in original, "existing_DuduHire_HBA_requires_reconciliation")
    require(query("SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL;") == "0", "existing_HBA_parse_errors")
    new_file(target / "pg_hba.conf.before", original)
    rules = ("# BEGIN DUDUHIRE - only the new database; existing databases unchanged\n"
             "local duduhire all reject\n"
             "hostnossl duduhire all 0.0.0.0/0 reject\n"
             "hostnossl duduhire all ::/0 reject\n"
             "hostssl duduhire duduhire_owner,duduhire_runtime,duduhire_maintenance 127.0.0.1/32 scram-sha-256\n"
             "hostssl duduhire all 0.0.0.0/0 reject\n"
             "hostssl duduhire all ::/0 reject\n"
             "# END DUDUHIRE\n").encode()

    def replace(content):
        temporary = hba.parent / (hba.name + ".duduhire-" + secrets.token_hex(4))
        new_file(temporary, content, stat.S_IMODE(original_stat.st_mode), original_stat.st_uid, original_stat.st_gid)
        os.replace(temporary, hba)

    phase("new_database_HBA_reload")
    try:
        replace(rules + original)
        require(query("SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL;") == "0", "new_HBA_parse_errors")
        require(query("SELECT pg_reload_conf();") == "t", "HBA_reload_not_accepted")
        time.sleep(0.5)
        executable = shutil.which("psql")
        require(executable is not None, "psql_unavailable")
        for role in ROLES:
            environment = {"PATH": "/usr/bin:/bin", "PGHOST": tls_state["host"], "PGPORT": "5432",
                           "PGDATABASE": "duduhire", "PGUSER": role, "PGPASSWORD": passwords[role],
                           "PGSSLMODE": "verify-full", "PGSSLROOTCERT": tls_state["ca"],
                           "PGCONNECT_TIMEOUT": "5", "PGPASSFILE": "/dev/null"}
            result = run([executable, "-X", "-w", "-qAt", "-c",
                "SELECT current_user || '|' || current_database() || '|' || (SELECT ssl::text FROM pg_stat_ssl WHERE pid=pg_backend_pid());"],
                environment=environment).decode().strip()
            require(result == role + "|duduhire|true", "new_role_TLS_authentication_failed")
        # Verified TLS succeeded immediately beforehand; plaintext must be rejected.
        environment["PGSSLMODE"] = "disable"
        denied = subprocess.run([executable, "-X", "-w", "-qAt", "-c", "SELECT 1;"],
                                env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
        require(denied.returncode != 0, "new_database_plaintext_was_not_rejected")
        require(hba.read_bytes() == rules + original, "HBA_changed_during_verification")
    except Exception:
        phase("restore_original_HBA")
        replace(original)
        require(query("SELECT pg_reload_conf();") == "t", "HBA_restore_reload_failed_manual_attention_required")
        require(hba.read_bytes() == original, "HBA_restore_content_mismatch_manual_attention_required")
        raise Stop("new_database_HBA_validation_failed_original_HBA_restored_reconcile_partial_database_env")


def database_env(args):
    target = selected_backup(args.backup)
    require(not (target / "database-env-complete.json").exists(), "database_env_step_already_completed")
    tls_state = json.loads((target / "tls-complete.json").read_text())
    ca = Path(tls_state["ca"])
    require(digest(ca) == tls_state["caSha256"], "CA_changed_since_TLS_verification")
    tls_probe(ca, tls_state["host"], tls_state["port"])
    phase("database_env_preconditions")
    existing = inventory()
    require("duduhire" not in existing["databases"] and not existing["roles"], "new_database_or_role_already_exists_reconcile_before_retry")
    provider = Path(args.provider)
    provider_stat = provider.lstat()
    require(provider.resolve() == provider and provider_stat.st_uid == 0 and provider_stat.st_nlink == 1
            and stat.S_ISREG(provider_stat.st_mode) and stat.S_IMODE(provider_stat.st_mode) == 0o600
            and provider_stat.st_size < 65536, "provider_file_must_be_root_owned_0600_regular_file")
    values = json.loads(provider.read_text())
    keys = {"QWEN_API_KEY", "PNVS_ACCESS_KEY_ID", "PNVS_ACCESS_KEY_SECRET", "PHONE_AUTH_ALLOWED_NUMBERS"}
    require(set(values) == keys and all(isinstance(v, str) and v.strip() and len(v) <= 4096
            and not re.search(r"[\r\n\x00]", v) for v in values.values()), "provider_file_shape_invalid")
    numbers = [v.strip() for v in values["PHONE_AUTH_ALLOWED_NUMBERS"].split(",")]
    require(1 <= len(numbers) <= 20 and all(re.fullmatch(r"(?:\+86)?1[3-9][0-9]{9}", v) for v in numbers), "approved_number_allowlist_invalid")
    require(not any((CONFIG / (name + ".env")).exists() for name in ("runtime", "migration", "maintenance")), "existing_env_files_require_reconciliation")
    try:
        account = pwd.getpwnam("duduhire")
        require(account.pw_uid != 0 and account.pw_dir == "/nonexistent" and account.pw_shell.endswith("nologin"), "existing_service_user_requires_review")
    except KeyError:
        nologin = shutil.which("nologin") or "/usr/sbin/nologin"
        require(Path(nologin).is_file(), "nologin_shell_unavailable")
        run(["useradd", "--system", "--home-dir", "/nonexistent", "--no-create-home", "--shell", nologin, "duduhire"])
    directory(Path("/opt/duduhire"), 0o755)
    directory(Path("/opt/duduhire/releases"), 0o755)
    passwords = {role: secrets.token_hex(32) for role in ROLES}
    urls = {role: "postgresql://" + role + ":" + passwords[role] + "@" + tls_state["host"] + ":5432/duduhire" for role in ROLES}
    deadline = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=23, minutes=59)).strftime("%Y-%m-%dT%H:%M:%SZ")
    runtime = {"NODE_ENV": "production", "HOST": "127.0.0.1", "PORT": "8788", "WEB_ORIGIN": "https://kylesong.top",
        "DATABASE_URL": urls[ROLES[1]], "DATABASE_SSL": "true", "NODE_EXTRA_CA_CERTS": str(ca),
        "AUTH_TOKEN_SECRET": secrets.token_urlsafe(48), "AUTH_COOKIE_NAME": "__Host-duduhire_session", "AUTH_COOKIE_SECURE": "true",
        "CONTACT_DATA_KEY": secrets.token_hex(32), "CONTACT_DATA_KEY_ID": "contact-" + target.name,
        "TRUST_PROXY_CIDRS": "127.0.0.1/32", "AI_MODE": "qwen", "QWEN_MODEL": "qwen-plus",
        "QWEN_BASE_URL": "https://dashscope.aliyuncs.com/compatible-mode/v1", "EMAIL_DELIVERY_MODE": "disabled",
        "PHONE_AUTH_ENABLED": "true", "PHONE_AUTH_DAILY_LIMIT": "2", "PHONE_AUTH_PHONE_HOURLY_LIMIT": "2",
        "PHONE_AUTH_IP_HOURLY_LIMIT": "2", "PHONE_AUTH_SEND_UNTIL": deadline, "PHONE_AUTH_CODE_TTL_SECONDS": "300",
        "PHONE_AUTH_RESEND_SECONDS": "60", "PHONE_AUTH_MAX_ATTEMPTS": "5", "LOG_LEVEL": "info", **values}
    profiles = {"runtime": runtime,
        "migration": {"NODE_ENV": "production", "MIGRATION_DATABASE_SSL": "true", "MIGRATION_DATABASE_URL": urls[ROLES[0]], "NODE_EXTRA_CA_CERTS": str(ca)},
        "maintenance": {"NODE_ENV": "production", "MAINTENANCE_DATABASE_SSL": "true", "MAINTENANCE_DATABASE_URL": urls[ROLES[2]], "NODE_EXTRA_CA_CERTS": str(ca)}}
    phase("write_private_env_files")
    for name, profile in profiles.items():
        # A quoted single-line subset shared by Node parseEnv and systemd EnvironmentFile.
        require(all(not re.search(r"['\\\r\n\x00]", value) for value in profile.values()), "env_value_requires_safe_manual_encoding")
        new_file(CONFIG / (name + ".env"), "".join(key + "='" + value + "'\n" for key, value in profile.items()))
    phase("create_independent_database_roles")
    execute("BEGIN;\n" + "\n".join("CREATE ROLE " + role + " LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD "
             + literal(scram(passwords[role])) + ";" for role in ROLES) + "\nCOMMIT;\n")
    execute("CREATE DATABASE duduhire OWNER duduhire_owner;\n")
    execute("""ALTER SCHEMA public OWNER TO duduhire_owner;
REVOKE CONNECT,TEMPORARY ON DATABASE duduhire FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE duduhire TO duduhire_owner,duduhire_runtime,duduhire_maintenance;
GRANT USAGE,CREATE ON SCHEMA public TO duduhire_owner;
GRANT USAGE ON SCHEMA public TO duduhire_runtime,duduhire_maintenance;
""", "duduhire")
    current = inventory()
    require("duduhire" in current["databases"] and set(current["roles"]) == set(ROLES), "created_database_inventory_incomplete")
    restrict_new_database_hba(target, current["settings"], tls_state, passwords)
    write_json(target / "database-env-complete.json", {"database": "duduhire", "roles": list(ROLES),
               "apiPort": 8788, "email": "disabled", "phoneDailyLimit": 2, "phoneSendUntil": deadline,
               "hba": "three roles verified over TLS/SCRAM; new database plaintext rejected; old HBA retained verbatim after new rules",
               "stage": "bootstrap prepared; application migrations, grants and runtime acceptance pending"})
    print("database_env_prepared=true; email=disabled; phone_daily_limit=2; phone_deadline=" + deadline)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command")
    commands.add_parser("backup", help="back up old files and zjad into a unique protected directory")
    tls_parser = commands.add_parser("tls", help="verify existing TLS or configure isolated TLS with rollback")
    tls_parser.add_argument("--backup", required=True)
    tls_parser.add_argument("--ca", help="required when PostgreSQL already has SSL enabled; certificate only")
    # libpq 13 matches the DNS SAN; Python's IP SAN check alone is insufficient.
    tls_parser.add_argument("--host", choices=("127.0.0.1", "localhost"), default="localhost")
    env_parser = commands.add_parser("database-env", help="create new independent database/roles and private environment files")
    env_parser.add_argument("--backup", required=True)
    env_parser.add_argument("--provider", default="/root/provider-secrets.json")
    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        return
    require(sys.platform.startswith("linux") and os.geteuid() == 0, "target_Linux_root_required")
    os.umask(0o077)
    {"backup": backup, "tls": tls, "database-env": database_env}[args.command](args)
    print("result=step_complete; nginx_and_old_services_not_changed")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        detail = str(error) if isinstance(error, Stop) else type(error).__name__
        print("ERROR phase=" + PHASE + " reason=" + detail + "; inspect partial state before retry", file=sys.stderr)
        sys.exit(1)
