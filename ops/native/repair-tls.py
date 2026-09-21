#!/usr/bin/env python3
"""Repair the confirmed duplicate CA extension; keep keys and old-site backup intact.

Python 3.6+, run beside the reviewed bootstrap.py. This changes only the new
PostgreSQL TLS certificate/configuration and reloads PostgreSQL; never restarts it.
"""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import secrets
import ssl
import stat
import sys
import time

sys.dont_write_bytecode = True
import bootstrap as b

CA_SHA256 = "5083859c8171c51aca60518452581cb2b57e1f1cb3bb3ffb78910f6ba0c01c8b"
CA_CONFIG = """[req]
distinguished_name=dn
prompt=no
x509_extensions=ca
[dn]
CN=DuduHire PostgreSQL Private CA
[ca]
basicConstraints=critical,CA:TRUE
keyUsage=critical,keyCertSign,cRLSign
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid:always
"""
CSR_CONFIG = """[req]
distinguished_name=dn
prompt=no
[dn]
CN=localhost
"""
LEAF_CONFIG = """[leaf]
subjectAltName=DNS:localhost,IP:127.0.0.1
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid:always
"""


def regular(path, uid=None, mode=None):
    info = path.lstat()
    b.require(stat.S_ISREG(info.st_mode) and path.resolve() == path,
              "expected_regular_file_without_symlink")
    if uid is not None:
        b.require(info.st_uid == uid, "file_owner_changed")
    if mode is not None:
        b.require(stat.S_IMODE(info.st_mode) == mode, "file_permissions_changed")
    return info


def replace(path, content, info):
    temporary = path.parent / (path.name + ".tls-repair-" + secrets.token_hex(4))
    try:
        b.new_file(temporary, content, stat.S_IMODE(info.st_mode), info.st_uid, info.st_gid)
        os.replace(str(temporary), str(path))
    finally:
        if temporary.exists():
            temporary.unlink()


def public_hash(path, private=False):
    command = (["openssl", "pkey", "-in", str(path), "-passin", "pass:", "-pubout"]
               if private else ["openssl", "x509", "-in", str(path), "-pubkey", "-noout"])
    public = b.run(command)
    der = b.run(["openssl", "pkey", "-pubin", "-outform", "DER"], public)
    return hashlib.sha256(der).hexdigest()


def extension_count(path):
    public = b.run(["openssl", "x509", "-in", str(path), "-noout", "-text"])
    return len(re.findall(br"X509v3 Basic Constraints:", public))


def make_candidates(repair, ca_key, server_key):
    # Explicit sections replace all implicit req/x509 extension selection. No -addext.
    for name, content in (("ca.cnf", CA_CONFIG), ("csr.cnf", CSR_CONFIG), ("leaf.cnf", LEAF_CONFIG)):
        b.new_file(repair / name, content)
    ca, leaf = repair / "ca.crt", repair / "server.crt"
    b.run(["openssl", "req", "-new", "-x509", "-key", str(ca_key), "-passin", "pass:",
           "-sha256", "-days", "3650", "-set_serial", "0x" + secrets.token_hex(16),
           "-config", str(repair / "ca.cnf"), "-extensions", "ca", "-out", str(ca)])
    b.run(["openssl", "req", "-new", "-key", str(server_key), "-passin", "pass:", "-sha256",
           "-config", str(repair / "csr.cnf"), "-out", str(repair / "server.csr")])
    b.run(["openssl", "req", "-in", str(repair / "server.csr"), "-verify", "-noout"])
    b.run(["openssl", "x509", "-req", "-in", str(repair / "server.csr"), "-CA", str(ca),
           "-CAkey", str(ca_key), "-passin", "pass:", "-set_serial", "0x" + secrets.token_hex(16),
           "-sha256", "-days", "825", "-extfile", str(repair / "leaf.cnf"),
           "-extensions", "leaf", "-out", str(leaf)])
    b.require(extension_count(ca) == 1 and extension_count(leaf) == 1,
              "candidate_basic_constraints_not_unique")
    b.run(["openssl", "verify", "-check_ss_sig", "-CAfile", str(ca), str(ca)])
    for option, name in (("-verify_hostname", "localhost"), ("-verify_ip", "127.0.0.1")):
        b.run(["openssl", "verify", "-CAfile", str(ca), "-purpose", "sslserver", option, name, str(leaf)])
    b.require(public_hash(ca) == public_hash(ca_key, True), "candidate_CA_key_mismatch")
    b.require(public_hash(leaf) == public_hash(server_key, True), "candidate_server_key_mismatch")
    return ca, leaf


def repaired_tls(backup):
    b.phase("tls_repair_confirm_observed_failure")
    target = b.selected_backup(str(backup))
    marker = target / "tls-complete.json"
    b.require(not marker.exists() and not marker.is_symlink(), "TLS_already_completed_review_before_retry")
    info = b.inventory()["settings"]
    b.require(info["ssl"] == "off", "expected_rolled_back_SSL_off")
    data = Path(info["data_directory"])
    auto = data / "postgresql.auto.conf"
    auto_info = regular(auto)
    saved_auto = target / "postgresql.auto.conf.before"
    regular(saved_auto, 0, 0o600)
    b.require(b.digest(auto) == b.digest(saved_auto), "auto_conf_no_longer_matches_original_backup")
    original_auto = auto.read_bytes()
    postgres = pwd.getpwnam("postgres")
    ca = b.CONFIG / "ca.crt"
    private = target / "private-ca"
    source_ca, ca_key = private / "ca.crt", private / "ca.key"
    server = data / "duduhire-tls"
    leaf, server_key = server / "server.crt", server / "server.key"
    ca_info = regular(ca, 0, 0o644)
    leaf_info = regular(leaf, postgres.pw_uid, 0o600)
    regular(ca_key, 0, 0o600)
    regular(server_key, postgres.pw_uid, 0o600)
    regular(source_ca, 0)
    b.require(b.digest(ca) == CA_SHA256 and b.digest(source_ca) == CA_SHA256,
              "observed_invalid_CA_changed_review_before_repair")
    b.require(extension_count(ca) == 2, "confirmed_duplicate_CA_condition_not_present")
    b.require(public_hash(ca) == public_hash(ca_key, True), "existing_CA_key_mismatch")
    b.require(public_hash(leaf) == public_hash(server_key, True), "existing_server_key_mismatch")
    original_ca, original_leaf = ca.read_bytes(), leaf.read_bytes()
    key_hashes = (b.digest(ca_key), b.digest(server_key))
    identifier = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ-") + secrets.token_hex(3)
    repair = target / ("tls-repair-" + identifier)
    b.directory(repair, 0o700)
    for name, content in (("invalid-ca.crt", original_ca), ("invalid-server.crt", original_leaf),
                          ("postgresql.auto.conf.before", original_auto)):
        b.new_file(repair / name, content)
    b.phase("tls_repair_candidates_and_offline_verification")
    candidate_ca, candidate_leaf = make_candidates(repair, ca_key, server_key)
    b.require(key_hashes == (b.digest(ca_key), b.digest(server_key)), "existing_private_key_changed")
    b.write_json(repair / "candidate-verified.json", {
        "caSha256": b.digest(candidate_ca), "serverSha256": b.digest(candidate_leaf),
        "privateKeysUnchanged": True, "verification": "CA self-signature, sslserver DNS/IP and both key matches"})
    b.phase("tls_repair_install_and_reload")
    # A concurrent change is not ours to roll back: check before entering mutation handling.
    b.require(b.inventory()["settings"]["ssl"] == "off" and auto.read_bytes() == original_auto
              and ca.read_bytes() == original_ca and leaf.read_bytes() == original_leaf,
              "TLS_inputs_changed_during_candidate_verification")
    try:
        replace(ca, candidate_ca.read_bytes(), ca_info)
        replace(leaf, candidate_leaf.read_bytes(), leaf_info)
        b.execute("ALTER SYSTEM SET ssl_cert_file=" + b.literal(str(leaf)) + ";\n"
                  "ALTER SYSTEM SET ssl_key_file=" + b.literal(str(server_key)) + ";\n"
                  "ALTER SYSTEM SET ssl='on';\n")
        b.require(b.query("SELECT pg_reload_conf();") == "t", "TLS_repair_reload_not_accepted")
        for attempt in range(12):
            try:
                active = b.inventory()["settings"]
                b.require(active["ssl"] == "on" and active["ssl_cert_file"] == str(leaf)
                          and active["ssl_key_file"] == str(server_key), "TLS_repair_reload_pending")
                b.tls_probe(ca, "127.0.0.1", int(info["port"]))
                b.tls_probe(ca, "localhost", int(info["port"]))
                break
            except (b.Stop, OSError, ssl.SSLError):
                if attempt == 11:
                    raise
                time.sleep(0.5)
        b.require(key_hashes == (b.digest(ca_key), b.digest(server_key)), "existing_private_key_changed")
        b.write_json(marker, {"ca": str(ca), "caSha256": b.digest(ca), "host": "127.0.0.1",
            "port": int(info["port"]), "mode": "duplicate_CA_reissued_with_existing_private_keys",
            "verified": "local certificate-verified TLS handshake",
            "verifiedHosts": ["127.0.0.1", "localhost"],
            "repairDirectory": str(repair)})
    except Exception:
        b.phase("tls_repair_restore_original_configuration_and_certificates")
        replace(auto, original_auto, auto_info)
        replace(ca, original_ca, ca_info)
        replace(leaf, original_leaf, leaf_info)
        b.require(b.query("SELECT pg_reload_conf();") == "t", "TLS_repair_restore_reload_failed_manual_attention_required")
        for attempt in range(12):
            if b.inventory()["settings"]["ssl"] == info["ssl"]:
                break
            time.sleep(0.5)
        b.require(b.inventory()["settings"]["ssl"] == info["ssl"]
                  and auto.read_bytes() == original_auto and ca.read_bytes() == original_ca
                  and leaf.read_bytes() == original_leaf,
                  "TLS_repair_restore_not_confirmed_manual_attention_required")
        if marker.exists():
            marker.unlink()
        raise b.Stop("TLS_repair_failed_original_config_and_certificates_restored_no_restart")
    print("tls_verified=true; private_keys_preserved=true; postgres_restarted=false")
    print("tls_repair_directory=" + str(repair))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backup", type=Path, required=True)
    args = parser.parse_args()
    b.require(sys.platform.startswith("linux") and os.geteuid() == 0, "target_Linux_root_required")
    os.umask(0o077)
    repaired_tls(args.backup)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("phase=" + b.PHASE + "; failed=true; reason=" +
              (str(error) if isinstance(error, b.Stop) else type(error).__name__), file=sys.stderr)
        sys.exit(1)
