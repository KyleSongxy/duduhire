#!/usr/bin/env python3
"""Python 3.6+: import fixed SMTP credentials from hidden terminal input.

Run as root with no arguments, then paste one base64-encoded JSON line.
Does not verify SMTP, send mail, or change the running service.
"""
import base64
import getpass
import json
import os
import re
import signal
import stat
import sys
import termios
import warnings
from urllib.parse import unquote, urlsplit

TARGET = "/root/duduhire-smtp.json"
SENDER = "no-reply@mail.kylesong.top"


class Stop(Exception):
    pass


def require(ok, reason):
    if not ok:
        raise Stop(reason)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "duplicate_JSON_key")
        result[key] = value
    return result


def parse_payload(encoded):
    require(isinstance(encoded, str) and 0 < len(encoded) <= 32768
            and re.fullmatch(r"[A-Za-z0-9+/]+={0,2}", encoded) is not None,
            "single_base64_line_required")
    try:
        raw = base64.b64decode(encoded, validate=True)
        require(base64.b64encode(raw).decode("ascii") == encoded,
                "canonical_base64_required")
        values = json.loads(raw.decode("utf-8"), object_pairs_hook=unique_object)
        require(isinstance(values, dict) and set(values) == {"SMTP_URL", "EMAIL_FROM"}
                and all(isinstance(value, str) and 0 < len(value) <= 8192
                        for value in values.values()), "SMTP_schema_invalid")
        require(values["EMAIL_FROM"] == "DuduHire <" + SENDER + ">",
                "fixed_DuduHire_sender_required")
        smtp = values["SMTP_URL"]
        require(all(ord(char) < 128 for char in smtp)
                and not re.search(r"[\s'\\\x00-\x1f\x7f]", smtp)
                and not re.search(r"%(?![0-9a-fA-F]{2})", smtp),
                "SMTP_URL_encoding_invalid")
        url = urlsplit(smtp)
        require(smtp.startswith("smtps://") and url.scheme == "smtps"
                and url.hostname == "smtpdm.aliyun.com" and url.port == 465
                and not url.path and not url.query and not url.fragment
                and unquote(url.username or "", errors="strict") == SENDER
                and bool(url.password), "fixed_TLS_SMTP_target_required")
        require(not re.search(r"[\x00-\x1f\x7f]", unquote(url.password, errors="strict")),
                "SMTP_password_encoding_invalid")
        return (json.dumps(values, ensure_ascii=True, separators=(",", ":")) + "\n").encode("ascii")
    except Stop:
        raise
    except (ValueError, UnicodeError, TypeError):
        raise Stop("SMTP_payload_invalid") from None


def preconditions():
    require(os.geteuid() == 0, "root_required")
    require(sys.stdin.isatty() and sys.stderr.isatty(), "interactive_TTY_required")
    info = os.lstat("/root")
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0
            and not info.st_mode & 0o022 and os.path.realpath("/root") == "/root",
            "protected_root_directory_required")
    require(not os.path.lexists(TARGET), "target_must_not_exist")


def hidden_input():
    descriptor = os.open("/dev/tty", os.O_RDWR | os.O_NOCTTY)
    original = None
    handlers = {}

    def interrupted(signum, frame):
        raise Stop("terminal_input_interrupted")

    try:
        original = termios.tcgetattr(descriptor)
        for name in ("SIGHUP", "SIGTERM", "SIGQUIT", "SIGTSTP"):
            number = getattr(signal, name, None)
            if number is not None:
                handlers[number] = signal.signal(number, interrupted)
        with warnings.catch_warnings():
            warnings.simplefilter("error", getpass.GetPassWarning)
            return getpass.getpass("SMTP JSON base64 (hidden): ", stream=sys.stderr)
    finally:
        try:
            if original is not None:
                termios.tcsetattr(descriptor, termios.TCSAFLUSH, original)
        finally:
            os.close(descriptor)
            for number, handler in handlers.items():
                signal.signal(number, handler)


def write_exclusive(data):
    descriptor = os.open(TARGET, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    created = os.fstat(descriptor)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            os.fchown(stream.fileno(), 0, 0)
            os.fchmod(stream.fileno(), 0o600)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        directory = os.open("/root", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    except BaseException:
        try:
            current = os.lstat(TARGET)
            if (current.st_dev, current.st_ino) == (created.st_dev, created.st_ino):
                os.unlink(TARGET)
        except OSError:
            pass
        raise


def main():
    try:
        require(len(sys.argv) == 1, "no_arguments_allowed")
        preconditions()
        data = parse_payload(hidden_input())
        write_exclusive(data)
        print("SMTP_PRIVATE_IMPORT_OK; SMTP_verified=false; emails_sent=0")
        return 0
    except Stop as error:
        print("SMTP_PRIVATE_IMPORT_REJECTED: " + str(error), file=sys.stderr)
    except (KeyboardInterrupt, EOFError):
        print("SMTP_PRIVATE_IMPORT_CANCELLED", file=sys.stderr)
    except BaseException:
        print("SMTP_PRIVATE_IMPORT_FAILED", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
