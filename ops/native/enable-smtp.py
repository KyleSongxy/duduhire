#!/usr/bin/env python3
"""Verify the installed SMTP transport, then enable email with health rollback.

Python 3.6+. Never sends mail. Credentials remain in root-only files/stdin.
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
from urllib.parse import unquote, urlsplit
from urllib.request import ProxyHandler, build_opener

RUNTIME = Path("/etc/duduhire/runtime.env")
CREDENTIALS = Path("/root/duduhire-smtp.json")
BACKUPS = Path("/root/duduhire-smtp-enablement")
NODE = "/usr/local/bin/node"
UNIT = "duduhire-api-staging.service"
SENDER = "no-reply@mail.kylesong.top"
FROM = "DuduHire <" + SENDER + ">"
PHASE = "preconditions"

NODE_VERIFY = r"""
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {parseEnv} from 'node:util';
let transport;
try {
  const input=JSON.parse(readFileSync(0,'utf8'));
  const prior=parseEnv(input.original), merged=parseEnv(input.candidate);
  const require=createRequire(pathToFileURL(input.release+'/apps/api/package.json'));
  const nodemailer=require('nodemailer');
  const {loadConfig}=await import(pathToFileURL(input.release+'/apps/api/dist/config.js'));
  const {createSmtpTransportOptions}=await import(pathToFileURL(input.release+'/apps/api/dist/email.js'));
  const oldConfig=loadConfig(prior), config=loadConfig(merged);
  if(oldConfig.environment!=='production' || oldConfig.emailDeliveryMode!=='disabled'
    || config.environment!=='production' || config.emailDeliveryMode!=='smtp'
    || config.emailFrom!=='DuduHire <no-reply@mail.kylesong.top>'
    || config.host!=='127.0.0.1' || config.port!==8788
    || config.webOrigin!=='https://kylesong.top') throw new Error();
  const changed=new Set(['EMAIL_DELIVERY_MODE','SMTP_URL','EMAIL_FROM']);
  for(const key of new Set([...Object.keys(prior),...Object.keys(merged)])) {
    if(!changed.has(key) && prior[key]!==merged[key]) throw new Error();
  }
  const options=createSmtpTransportOptions(config.smtpUrl,true);
  if(options.host!=='smtpdm.aliyun.com' || options.port!==465 || !options.secure
    || !options.requireTLS || options.ignoreTLS || options.auth?.user!=='no-reply@mail.kylesong.top') throw new Error();
  transport=nodemailer.createTransport({...options,logger:false,debug:false,
    tls:{servername:'smtpdm.aliyun.com',rejectUnauthorized:true}});
  if(await transport.verify()!==true) throw new Error();
  console.log('smtp_auth_verified=true; production_config_valid=true; emails_sent=0');
} catch {
  console.error('SMTP_AUTH_OR_PRODUCTION_CONFIG_VERIFICATION_FAILED');
  process.exitCode=1;
} finally { transport?.close(); }
"""


class Stop(Exception):
    pass


def require(ok, reason):
    if not ok:
        raise Stop(reason)


def phase(name):
    global PHASE
    PHASE = name
    print("phase=" + name, flush=True)


def regular(path, private=False):
    info = path.lstat()
    require(path.resolve() == path and stat.S_ISREG(info.st_mode) and info.st_nlink == 1
            and info.st_uid == 0 and not info.st_mode & 0o022, "root_regular_file_required")
    require(not private or (stat.S_IMODE(info.st_mode) == 0o600 and info.st_size < 65536),
            "root_0600_private_file_required")
    return info


def directory(path):
    if not path.exists() and not path.is_symlink():
        path.mkdir(mode=0o700)
    info = path.lstat()
    require(path.resolve() == path and stat.S_ISDIR(info.st_mode) and info.st_uid == 0
            and stat.S_IMODE(info.st_mode) == 0o700, "root_0700_backup_directory_required")


def run(args, data=None, timeout=40):
    result = subprocess.run(args, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        timeout=timeout, check=False,
        env={"PATH": "/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"})
    require(result.returncode == 0, "command_failed:" + Path(args[0]).name)
    return result.stdout


def parse_env(raw):
    values = {}
    for line in raw.decode("utf8").splitlines():
        match = re.fullmatch(r"([A-Z][A-Z0-9_]*)='([^'\\\r\n\x00]*)'", line)
        require(match is not None, "generated_env_format_changed")
        key, value = match.groups()
        require(key not in values, "duplicate_env_key")
        values[key] = value
    return values


def candidate_env(original, supplied):
    require(set(supplied) == {"SMTP_URL", "EMAIL_FROM"}
            and all(isinstance(v, str) and 0 < len(v) <= 8192 for v in supplied.values()),
            "SMTP_credentials_schema_invalid")
    require(supplied["EMAIL_FROM"] == FROM, "DuduHire_sender_required")
    raw = supplied["SMTP_URL"]
    require(raw.isascii() if hasattr(raw, "isascii") else all(ord(c) < 128 for c in raw),
            "SMTP_URL_must_be_ASCII_percent_encoded")
    require(not re.search(r"[\s'\\\x00-\x1f\x7f]", raw)
            and not re.search(r"%(?![0-9a-fA-F]{2})", raw), "SMTP_URL_encoding_invalid")
    url = urlsplit(raw)
    require(url.scheme == "smtps" and url.hostname == "smtpdm.aliyun.com" and url.port == 465
            and not url.path and not url.query and not url.fragment
            and unquote(url.username or "") == SENDER and bool(url.password), "fixed_TLS_SMTP_target_required")
    require(not re.search(r"[\x00-\x1f\x7f]", unquote(url.password)), "SMTP_password_encoding_invalid")
    values = parse_env(original)
    require(values.get("NODE_ENV") == "production" and values.get("EMAIL_DELIVERY_MODE") == "disabled",
            "existing_production_disabled_mode_required")
    values.update(supplied)
    values["EMAIL_DELIVERY_MODE"] = "smtp"
    candidate = "".join(key + "='" + value + "'\n" for key, value in values.items()).encode()
    require(parse_env(candidate) == values, "candidate_env_encoding_invalid")
    return candidate


def new_file(path, data, gid=0):
    descriptor = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as stream:
        os.fchown(stream.fileno(), 0, gid)
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def replace_runtime(data, info):
    temporary = RUNTIME.parent / (".runtime.env.smtp-" + secrets.token_hex(6))
    try:
        new_file(temporary, data, info.st_gid)
        os.replace(str(temporary), str(RUNTIME))
        descriptor = os.open(str(RUNTIME.parent), os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        if temporary.exists():
            temporary.unlink()


def health(expected_email, wait_seconds=35):
    opener = build_opener(ProxyHandler({}))
    deadline = time.monotonic() + wait_seconds
    while True:
        try:
            run(["systemctl", "is-active", "--quiet", UNIT], timeout=5)
            for route, expected in (("/api/health/live", "ok"), ("/api/health/ready", "ready")):
                with opener.open("http://127.0.0.1:8788" + route, timeout=2) as response:
                    require(json.loads(response.read(65536))["status"] == expected, "health_status_invalid")
            with opener.open("http://127.0.0.1:8788/api/v1/auth/methods", timeout=2) as response:
                require(json.loads(response.read(65536))["email"]["available"] is expected_email,
                        "email_availability_invalid")
            return
        except Exception:
            if time.monotonic() >= deadline:
                raise Stop("service_health_or_email_availability_failed")
            time.sleep(0.5)


def enable(apply):
    regular(CREDENTIALS, True)
    info = regular(RUNTIME, True)
    unit_file = Path("/etc/systemd/system") / UNIT
    regular(unit_file)
    require(run(["systemctl", "show", UNIT, "--property=FragmentPath", "--value"]).decode().strip()
            == str(unit_file), "existing_service_unit_required")
    release = Path(run(["systemctl", "show", UNIT, "--property=WorkingDirectory", "--value"]).decode().strip())
    require(release.parent == Path("/opt/duduhire/releases") and release.resolve() == release
            and re.fullmatch(r"duduhire-[A-Za-z0-9_-]+", release.name) is not None, "installed_release_required")
    for name in ("apps/api/dist/config.js", "apps/api/dist/email.js", "apps/api/package.json"):
        regular(release / name)
    run([NODE, "-e", "const [a,b]=process.versions.node.split('.').map(Number);if(a<22||(a===22&&b<13))process.exit(1)"])
    original = RUNTIME.read_bytes()
    candidate = candidate_env(original, json.loads(CREDENTIALS.read_text()))
    health(False, 0)
    phase("verify_installed_production_config_and_SMTP_AUTH")
    run([NODE, "--input-type=module", "-e", NODE_VERIFY], json.dumps({"release": str(release),
        "original": original.decode(), "candidate": candidate.decode()}).encode(), timeout=40)
    print("smtp_auth_verified=true; production_config_valid=true; emails_sent=0", flush=True)
    if not apply:
        return
    require(RUNTIME.read_bytes() == original, "runtime_changed_during_verification")
    phase("backup_original_runtime")
    directory(BACKUPS)
    attempt = BACKUPS / (dt.datetime.utcnow().strftime("%Y%m%dT%H%M%SZ-") + secrets.token_hex(3))
    directory(attempt)
    new_file(attempt / "runtime.env.before", original)
    print("smtp_backup_directory=" + str(attempt), flush=True)
    try:
        phase("enable_SMTP_and_restart_existing_API")
        replace_runtime(candidate, info)
        run(["systemctl", "restart", UNIT], timeout=40)
        health(True)
        require(RUNTIME.read_bytes() == candidate, "runtime_changed_after_restart")
    except Exception:
        phase("restore_original_runtime_and_API")
        try:
            replace_runtime(original, info)
            run(["systemctl", "restart", UNIT], timeout=40)
            health(False)
            require(RUNTIME.read_bytes() == original, "runtime_restore_mismatch")
            new_file(attempt / "ROLLED_BACK", b"original runtime restored; API healthy; email disabled\n")
        except Exception:
            new_file(attempt / "ROLLBACK_FAILED", b"Manual recovery required using runtime.env.before\n")
            raise Stop("SMTP_enable_failed_and_rollback_not_verified_manual_recovery_required")
        raise Stop("SMTP_enable_failed_original_runtime_and_healthy_API_restored")
    new_file(attempt / "COMPLETE", b"SMTP AUTH verified; production API ready; email available; no mail sent\n")
    print("smtp_enabled=true; live=true; ready=true; email_available=true; emails_sent=0")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--verify-only", action="store_true", help="TLS/SMTP AUTH and config check; no env mutation")
    modes.add_argument("--apply", action="store_true", help="verify, back up, enable SMTP and restart with rollback")
    args = parser.parse_args()
    require(sys.platform.startswith("linux") and os.geteuid() == 0, "target_Linux_root_required")
    os.umask(0o077)
    regular(RUNTIME, True)
    lock = RUNTIME.parent / ".enable-smtp.lock"
    descriptor = os.open(str(lock), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        enable(args.apply)
    finally:
        os.close(descriptor)
        lock.unlink()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        detail = str(error) if isinstance(error, Stop) else type(error).__name__
        print("ERROR phase=" + PHASE + " reason=" + detail + "; credential values suppressed", file=sys.stderr)
        sys.exit(1)
