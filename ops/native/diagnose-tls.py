#!/usr/bin/env python3
"""Read-only PostgreSQL TLS diagnosis; Python 3.6+, no reload or configuration writes."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys

SAFE_SETTINGS = (
    "ssl", "ssl_library", "ssl_cert_file", "ssl_key_file", "ssl_ca_file",
    "ssl_ciphers", "ssl_ecdh_curve", "ssl_dh_params_file", "ssl_min_protocol_version",
    "ssl_max_protocol_version", "ssl_prefer_server_ciphers", "ssl_passphrase_command_supports_reload",
    "data_directory", "config_file", "hba_file", "port", "listen_addresses", "server_version",
    "logging_collector", "log_destination", "log_directory", "log_filename", "log_timezone",
)
# Whitelisted message classes only. Raw stderr/database log lines never leave the process.
KNOWN_ERRORS = (
    (r"SSL is not supported by this build", "ssl_not_compiled"),
    (r"SSL configuration was not reloaded", "ssl_reload_rejected"),
    (r"could not load server certificate file", "server_certificate_load_failed"),
    (r"could not load private key file", "private_key_load_failed"),
    (r"could not access private key file", "private_key_access_failed"),
    (r"private key file .* has group or world access", "private_key_permissions_too_open"),
    (r"private key file .* must be owned by", "private_key_owner_invalid"),
    (r"check of private key failed", "certificate_private_key_mismatch"),
    (r"could not load root certificate file", "configured_root_certificate_load_failed"),
    (r"could not load DH parameters", "dh_parameters_load_failed"),
    (r"could not set the cipher list", "cipher_list_invalid"),
    (r"could not set ECDH curve", "ecdh_curve_invalid"),
    (r"could not set minimum SSL protocol version", "minimum_protocol_invalid"),
    (r"could not set maximum SSL protocol version", "maximum_protocol_invalid"),
    (r"could not initialize SSL", "ssl_initialization_failed"),
    (r"could not create SSL context", "ssl_context_failed"),
    (r"could not accept SSL connection", "tls_handshake_failed"),
    (r"certificate verify failed|alert bad certificate|alert unknown ca", "tls_peer_certificate_rejected"),
    (r"cannot be changed without restarting", "restart_required"),
    (r"permission denied", "permission_denied"),
    (r"no such file or directory", "file_not_found"),
    (r"key values mismatch", "certificate_private_key_mismatch"),
    (r"certificate has expired", "certificate_expired"),
    (r"certificate is not yet valid", "certificate_not_yet_valid"),
    (r"unable to get local issuer certificate|unable to get issuer certificate", "issuer_not_trusted"),
    (r"self.signed certificate", "self_signed_chain_not_trusted"),
    (r"IP address mismatch|hostname mismatch", "certificate_name_mismatch"),
    (r"unsupported certificate purpose", "certificate_purpose_invalid"),
    (r"ee key too small|ca key too small|key too weak", "certificate_key_strength_rejected"),
    (r"digest too weak|ca md too weak", "certificate_digest_rejected"),
    (r"unsupported protocol|no protocols available", "protocol_unavailable"),
    (r"no shared cipher|no ciphers available", "cipher_unavailable"),
    (r"syntax error", "configuration_syntax_error"),
    (r"unrecognized configuration parameter", "configuration_parameter_unknown"),
    (r"invalid value for parameter", "configuration_parameter_invalid"),
)


def classes(text):
    return sorted(set(code for pattern, code in KNOWN_ERRORS if re.search(pattern, text, re.I)))


def capture(args, data=None, timeout=12):
    try:
        input_options = {"input": data} if data is not None else {"stdin": subprocess.DEVNULL}
        result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=timeout, check=False, **input_options)
        return result.returncode, result.stdout, result.stderr
    except (OSError, subprocess.TimeoutExpired):
        return 124, b"", b""


def status(code, error=b""):
    return {"ok": code == 0, "exit": code, "knownErrors": classes(error.decode("utf8", "replace"))}


def pg_inventory():
    names = ",".join("'" + name + "'" for name in SAFE_SETTINGS)
    sql = """SELECT json_build_object(
      'settings',(SELECT coalesce(json_agg(json_build_object('name',name,'setting',setting,
        'context',context,'pending_restart',pending_restart,'source',source,'sourcefile',sourcefile,
        'sourceline',sourceline)),'[]'::json) FROM pg_settings WHERE name IN (%s)),
      'fileSettings',(SELECT coalesce(json_agg(json_build_object('name',name,'applied',applied,
        'error',error,'sourcefile',sourcefile,'sourceline',sourceline)),'[]'::json)
        FROM pg_file_settings WHERE name IN (%s) OR error IS NOT NULL),
      'currentLog',pg_current_logfile())::text;""" % (names, names)
    binary = shutil.which("psql")
    if not binary:
        return {"available": False, "reason": "psql_unavailable"}, None
    code, output, error = capture(["sudo", "-n", "-u", "postgres", "env", "-i", "PATH=/usr/bin:/bin",
        "PGCONNECT_TIMEOUT=3", "PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=5000",
        binary, "-X", "-w", "-qAt", "-d", "postgres", "-c", sql])
    if code:
        return {"available": False, "query": status(code, error)}, None
    try:
        value = json.loads(output.decode("utf8"))
    except (ValueError, UnicodeError):
        return {"available": False, "reason": "unexpected_query_result"}, None
    safe_rows = []
    for row in value["fileSettings"]:
        # Even malformed unrelated lines can contain passwords: never output raw errors/settings.
        safe_rows.append({"name": row["name"] if row["name"] in SAFE_SETTINGS else "unattributed_config_error",
                          "applied": row["applied"], "sourcefile": row["sourcefile"],
                          "sourceline": row["sourceline"], "hasError": row["error"] is not None,
                          "knownErrors": classes(row["error"] or "")})
    return {"available": True, "settings": value["settings"], "fileSettings": safe_rows,
            "note": "Current files are inspected after rollback; failed attempted values may no longer be present."}, value


def metadata(path):
    result = {"path": str(path)}
    try:
        info = path.lstat()
        result.update({"exists": True, "mode": oct(stat.S_IMODE(info.st_mode)), "uid": info.st_uid,
                       "gid": info.st_gid, "regular": stat.S_ISREG(info.st_mode), "symlink": path.is_symlink()})
        code, _, _ = capture(["sudo", "-n", "-u", "postgres", "test", "-r", str(path)])
        result["postgresReadable"] = code == 0
    except OSError:
        result["exists"] = False
    return result


def certificates(data):
    server = data / "duduhire-tls"
    ca, certificate, key = Path("/etc/duduhire/ca.crt"), server / "server.crt", server / "server.key"
    result = {"files": [metadata(path) for path in (ca, certificate, key)], "parents": []}
    for path in (Path("/etc/duduhire"), data, server):
        row = metadata(path)
        code, _, _ = capture(["sudo", "-n", "-u", "postgres", "test", "-x", str(path)])
        row["postgresCanTraverse"] = code == 0
        result["parents"].append(row)
    for name, path in (("caPublicDetails", ca), ("serverPublicDetails", certificate)):
        code, output, error = capture(["openssl", "x509", "-in", str(path), "-noout", "-subject", "-issuer", "-dates", "-fingerprint", "-sha256"])
        result[name] = status(code, error)
        if code == 0:
            result[name]["publicDetails"] = output.decode("utf8", "replace").strip().splitlines()[:8]
    code, output, error = capture(["openssl", "x509", "-in", str(certificate), "-noout", "-ext", "subjectAltName"])
    result["serverSAN"] = status(code, error)
    if code == 0:
        result["serverSAN"]["publicDetails"] = output.decode("utf8", "replace").strip().splitlines()[:3]
    for name, verify_option, hostname in (("verifyIP", "-verify_ip", "127.0.0.1"), ("verifyHostname", "-verify_hostname", "localhost")):
        code, _, error = capture(["openssl", "verify", "-CAfile", str(ca), "-purpose", "sslserver",
                                  verify_option, hostname, str(certificate)])
        result[name] = status(code, error)
    hashes = {}
    commands = {
        "certificate": ["openssl", "x509", "-in", str(certificate), "-pubkey", "-noout"],
        "privateKey": ["sudo", "-n", "-u", "postgres", "openssl", "pkey", "-in", str(key), "-passin", "pass:", "-pubout"],
    }
    for name, command in commands.items():
        code, public, error = capture(command)
        result[name + "PublicKeyRead"] = status(code, error)
        if code == 0:
            code, der, error = capture(["openssl", "pkey", "-pubin", "-outform", "DER"], public)
            result[name + "PublicKeyNormalize"] = status(code, error)
            if code == 0:
                hashes[name] = hashlib.sha256(der).hexdigest()
    result["publicKeySHA256"] = hashes
    result["certificateKeyMatch"] = hashes.get("certificate") == hashes.get("privateKey") if len(hashes) == 2 else None
    return result


def sanitized_logs(raw, source):
    observations = {}
    for line in raw.decode("utf8", "replace").splitlines():
        severity = re.search(r"(?:^|[\s,])(LOG|ERROR|FATAL|WARNING):\s*(.*)$", line)
        if not severity:
            continue
        message = severity.group(2)
        if re.match(r"(?:statement|parameters|execute\s|duration)\s*:", message, re.I):
            continue
        # Generic permission/config errors are relevant only when the line itself names TLS.
        if not re.search(r"SSL|TLS|certificate|private key|cipher|ECDH|DH parameters|ssl_", message, re.I):
            continue
        stamp = re.search(r"\b\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?", line)
        for code in classes(message):
            item = observations.setdefault(code, {"code": code, "count": 0})
            item["count"] += 1
            if stamp:
                item.setdefault("firstLogTimestampText", stamp.group(0))
                item["lastLogTimestampText"] = stamp.group(0)
    return {"source": source, "bytesScanned": len(raw), "knownTLSMessages": list(observations.values()),
            "note": "Only known TLS error classes are emitted; timestamps retain the server log timezone. Empty results do not prove no error."}


def logs(data, info, maximum):
    output = []
    current = info.get("currentLog") if info else None
    if current:
        path = Path(current) if current.startswith("/") else data / current
        try:
            with path.open("rb") as stream:
                stream.seek(0, 2)
                stream.seek(max(0, stream.tell() - maximum))
                raw = stream.read(maximum)
            output.append(sanitized_logs(raw, str(path)))
        except OSError:
            output.append({"source": str(path), "available": False})
    # Bounded journal query may be empty with PostgreSQL's own logging collector.
    code, raw, error = capture(["journalctl", "_COMM=postgres", "--since", "2026-09-12 13:45:00 UTC",
                                "--no-pager", "--output=cat", "-n", "300"])
    if code == 0:
        output.append(sanitized_logs(raw[-maximum:], "journal:postgres since 2026-09-12 13:45 UTC"))
    else:
        output.append({"source": "journal:postgres", "available": False, "query": status(code, error)})
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backup", type=Path, default=Path("/root/duduhire-backups/20260912T134804Z-4fe2ad"))
    parser.add_argument("--max-log-bytes", type=int, default=1048576)
    args = parser.parse_args()
    if not sys.platform.startswith("linux") or os.geteuid() != 0:
        raise RuntimeError("Run on the target Linux server as root; no local/server changes made")
    if not 1024 <= args.max_log_bytes <= 2097152:
        raise RuntimeError("Log scan must be between 1024 and 2097152 bytes")
    postgres, info = pg_inventory()
    settings = {row["name"]: row["setting"] for row in info["settings"]} if info else {}
    data = Path(settings.get("data_directory", "/var/lib/pgsql/data"))
    result = {"readOnly": True, "postgres": postgres, "certificates": certificates(data)}
    code, output, error = capture(["openssl", "version"])
    result["openssl"] = {"status": status(code, error), "publicVersion": output.decode("ascii", "replace").strip() if code == 0 else None}
    code, output, error = capture(["pg_config", "--configure"])
    result["postgresBuild"] = {"query": status(code, error), "withOpenSSLFlag": b"--with-openssl" in output if code == 0 else None,
                               "note": "pg_config may belong to another installation; ssl_library from the running server is stronger evidence."}
    original, active = args.backup / "postgresql.auto.conf.before", data / "postgresql.auto.conf"
    try:
        result["autoConfMatchesBackup"] = hashlib.sha256(original.read_bytes()).digest() == hashlib.sha256(active.read_bytes()).digest()
    except OSError:
        result["autoConfMatchesBackup"] = None
    result["logs"] = logs(data, info, args.max_log_bytes)
    result["boundary"] = "No SQL mutation, reload, restart, private-key output, raw log dump or TLS re-enable was attempted."
    print(json.dumps(result, indent=2, sort_keys=True))
    if not postgres["available"]:
        sys.exit(1)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"readOnly": True, "diagnosisIncomplete": True, "errorType": type(error).__name__,
                          "note": "Raw errors suppressed; check command availability and input paths."}), file=sys.stderr)
        sys.exit(1)
