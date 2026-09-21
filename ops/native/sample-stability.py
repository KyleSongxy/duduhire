#!/usr/bin/env python3
"""Read-only Python 3.6+ checks every 30 seconds for 15 minutes.

Run after deployment changes stop. Prints only health booleans, service counters,
and journal priority totals. Does not read credentials or journal MESSAGE fields.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import datetime as dt
import json
import os
import ssl
import subprocess
import sys
import time
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, HTTPSHandler, ProxyHandler, build_opener

API = "duduhire-api-staging.service"
UNITS = (API, "nginx.service")
PROPERTIES = ("LoadState", "ActiveState", "MainPID", "NRestarts", "ExecMainStartTimestampMonotonic")
TARGETS = (
    ("local_live", "http://127.0.0.1:8788/api/health/live", "ok"),
    ("local_ready", "http://127.0.0.1:8788/api/health/ready", "ready"),
    ("public_live", "https://kylesong.top/api/health/live", "ok"),
    ("public_ready", "https://kylesong.top/api/health/ready", "ready"),
    ("public_methods", "https://kylesong.top/api/v1/auth/methods", None),
)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def emit(value):
    print(json.dumps(value, sort_keys=True, separators=(",", ":")), flush=True)


def command(args, timeout=5):
    return subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        timeout=timeout, check=False,
        env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"})


def probe(target, expected_email):
    name, url, expected_status = target
    result = {"name": name, "ok": False}
    started = time.monotonic()
    try:
        opener = build_opener(ProxyHandler({}), NoRedirect(),
                              HTTPSHandler(context=ssl.create_default_context()))
        with opener.open(url, timeout=4) as response:
            result["http"] = response.status
            raw = response.read(65537)
            if response.status != 200 or len(raw) > 65536:
                return result
            body = json.loads(raw.decode("utf-8"))
            if expected_status is not None:
                result["ok"] = body.get("status") == expected_status
            else:
                email = body.get("email", {}).get("available")
                phone = body.get("phone", {}).get("available")
                if type(email) is bool and type(phone) is bool:
                    result.update(email_available=email, phone_available=phone,
                                  ok=email is expected_email)
    except HTTPError as error:
        result["http"] = error.code
    except Exception:
        result["error"] = "request_or_response_check_failed"
    finally:
        result["elapsed_ms"] = round((time.monotonic() - started) * 1000)
    return result


def service(unit):
    result = {"unit": unit, "ok": False}
    try:
        completed = command(["systemctl", "show", unit, "--property=" + ",".join(PROPERTIES)])
        if completed.returncode != 0:
            return result
        values = dict(line.split("=", 1) for line in completed.stdout.decode("ascii").splitlines()
                      if "=" in line)
        result["loaded"] = values.get("LoadState") == "loaded"
        result["active"] = values.get("ActiveState") == "active"
        for key in PROPERTIES[2:]:
            value = values.get(key, "")
            result[key] = int(value) if value.isdigit() else None
        result["ok"] = result["loaded"] and result["active"] and all(
            result[key] is not None for key in PROPERTIES[2:]) and result["MainPID"] > 0
    except Exception:
        result["error"] = "service_metadata_unavailable"
    return result


def journal_counts(started_epoch, ended_epoch):
    result = {"ok": False, "scope": "API_journal_priority_0_to_4", "messages_read": False}
    try:
        completed = command(["journalctl", "--quiet", "--no-pager", "--unit=" + API,
            "--since=@" + str(int(started_epoch)), "--until=@" + str(int(ended_epoch)),
            "--priority=0..4", "--lines=1001", "--output=json", "--output-fields=PRIORITY"], timeout=10)
        if completed.returncode != 0:
            result["error"] = "journal_priority_filter_unavailable"
            return result
        counts = {str(level): 0 for level in range(5)}
        for line in completed.stdout.splitlines():
            row = json.loads(line.decode("utf-8"))
            if "MESSAGE" in row or row.get("PRIORITY") not in counts:
                result["error"] = "journal_field_filter_invalid"
                return result
            counts[row["PRIORITY"]] += 1
        total = sum(counts.values())
        result.update(ok=True, counts=counts, truncated=total >= 1001,
                      errors=sum(counts[str(level)] for level in range(4)), warnings=counts["4"])
    except Exception:
        result["error"] = "journal_priority_check_failed"
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--expect-email", required=True, choices=("enabled", "disabled"))
    parser.add_argument("--once", action="store_true", help="one immediate read-only sample")
    args = parser.parse_args()
    if not sys.platform.startswith("linux") or os.geteuid() != 0:
        print("Target Linux root required", file=sys.stderr)
        return 2
    epoch, started = time.time(), time.monotonic()
    baseline, failures, changes = {}, 0, 0
    count = 1 if args.once else 31
    for index in range(count):
        if index:
            time.sleep(max(0, started + index * 30 - time.monotonic()))
        with ThreadPoolExecutor(max_workers=len(TARGETS)) as executor:
            checks = list(executor.map(lambda target: probe(target, args.expect_email == "enabled"), TARGETS))
        services = [service(unit) for unit in UNITS]
        for item in services:
            identity = tuple(item.get(key) for key in PROPERTIES[2:])
            if index == 0:
                baseline[item["unit"]] = identity
            item["unchanged_since_first_sample"] = identity == baseline[item["unit"]]
            if not item["unchanged_since_first_sample"]:
                changes += 1
        ok = all(item["ok"] for item in checks + services) and all(
            item["unchanged_since_first_sample"] for item in services)
        failures += int(not ok)
        emit({"sample": index + 1, "utc": dt.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
              "ok": ok, "checks": checks, "services": services})
    journal = journal_counts(epoch, time.time())
    emit({"complete": True, "sampling_window_seconds": round(time.monotonic() - started),
          "samples": count, "failed_samples": failures, "changed_service_samples": changes,
          "health_and_process_stable": failures == 0, "journal": journal,
          "delivery_or_registration_tested": False})
    return 0 if failures == 0 and journal["ok"] and not journal["truncated"] and journal["errors"] == 0 else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("SAMPLING_INTERRUPTED; stability_window_incomplete", file=sys.stderr)
        sys.exit(130)
    except Exception:
        print("SAMPLING_FAILED; details_suppressed", file=sys.stderr)
        sys.exit(1)
