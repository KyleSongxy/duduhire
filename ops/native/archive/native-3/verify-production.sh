#!/usr/bin/env bash
# Public GET-only checks for native-3; no credentials, cookies, SMS, email or AI calls.
set -eu
exec python3 - "$@" <<'PY'
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
from html.parser import HTMLParser
import json
import ssl
import sys
from urllib.error import HTTPError
from urllib.request import build_opener, HTTPRedirectHandler, HTTPSHandler, Request

MAIN = "https://kylesong.top"
API = "https://api.kylesong.top"
JS = "/assets/index-Bno7PqwM.js"
CSS = "/assets/index-mDrsYt0Y.css"
ASSETS = {
    JS: ("deebdce0d6c7ccb216ffaf1d4f1796cac34421161c68a88a82405a3ce4b44b3d", {"application/javascript", "text/javascript"}),
    CSS: ("5a808f03cf1c5625bb88bd1cdf5f0535af31428133f1c6d7764fe20e0327e629", {"text/css"}),
    "/service-worker.js": ("73e1a91819e7c695b73fea9510db47748ac5ea1ebe2a48ecadc68283ce133088", {"application/javascript", "text/javascript"}),
}


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, newurl):
        return None


class Index(HTMLParser):
    def __init__(self):
        HTMLParser.__init__(self)
        self.scripts, self.styles, self.title = [], [], ""
        self.in_title = False

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "title":
            self.in_title = True
        if tag == "script" and attrs.get("type") == "module":
            self.scripts.append(attrs.get("src"))
        if tag == "link" and attrs.get("rel") == "stylesheet":
            self.styles.append(attrs.get("href"))

    def handle_endtag(self, tag):
        if tag == "title":
            self.in_title = False

    def handle_data(self, value):
        if self.in_title:
            self.title += value


def fetch(url):
    # TLS validation stays enabled. Redirects are inspected, never followed.
    opener = build_opener(NoRedirect(), HTTPSHandler(context=ssl.create_default_context()))
    request = Request(url, headers={"User-Agent": "DuduHire-native-3-readonly-verifier",
                                   "Accept-Encoding": "identity", "Cache-Control": "no-cache"}, method="GET")
    try:
        try:
            response = opener.open(request, timeout=12)
        except HTTPError as error:
            response = error
        with response:
            body = response.read(8 * 1024 * 1024 + 1)
            if len(body) > 8 * 1024 * 1024:
                raise ValueError("response_size_limit")
            return {"status": response.code, "headers": response.headers, "body": body}
    except Exception as error:
        return {"status": None, "headers": {}, "body": b"", "error": type(error).__name__}


def main():
    parser = argparse.ArgumentParser(description="GET-only native-3 production checks; requires Python 3.6+. Does not prove rendered UI, Qwen execution, SMS or email delivery.")
    parser.add_argument("--email-mode", choices=("disabled", "smtp"), default="disabled")
    parser.add_argument("--phone-available", choices=("true", "false"), default="true",
                        help="Expected public capability flag, not proof of allowlist/deadline/quota or SMS delivery")
    args = parser.parse_args()
    paths = ("/api/health/live", "/api/health/ready", "/api/v1/auth/methods")
    urls = [MAIN + "/", "https://www.kylesong.top/"] + [MAIN + path for path in ASSETS]
    urls += [origin + path for origin in (MAIN, API) for path in paths]
    with ThreadPoolExecutor(max_workers=3) as pool:
        responses = dict(zip(urls, pool.map(fetch, urls)))
    failures = []

    def check(name, success, **details):
        if not success:
            failures.append(name)
        print(json.dumps(dict({"check": name, "passed": bool(success)}, **details), sort_keys=True), flush=True)

    root = responses[MAIN + "/"]
    document = Index()
    try:
        document.feed(root["body"].decode("utf8"))
        correct_html = "DuduHire" in document.title and JS in document.scripts and CSS in document.styles
    except (ValueError, UnicodeError):
        correct_html = False
    check("main_native_3_HTML", root["status"] == 200 and correct_html
          and root["headers"].get("Content-Type", "").lower().startswith("text/html"),
          status=root["status"], error=root.get("error"))
    www = responses["https://www.kylesong.top/"]
    check("www_canonical_redirect", www["status"] == 308 and www["headers"].get("Location") == MAIN + "/",
          status=www["status"], error=www.get("error"))
    for path, (expected, types) in ASSETS.items():
        response = responses[MAIN + path]
        mime = response["headers"].get("Content-Type", "").split(";", 1)[0].lower().strip()
        digest = hashlib.sha256(response["body"]).hexdigest()
        check(path, response["status"] == 200 and mime in types and digest == expected,
              status=response["status"], contentType=mime, sha256Matches=digest == expected, error=response.get("error"))
        if path == "/service-worker.js":
            cache = response["headers"].get("Cache-Control", "").lower()
            check("retirement_worker_not_cached", "no-cache" in cache or "no-store" in cache)
    for origin in (MAIN, API):
        for path in paths:
            response = responses[origin + path]
            try:
                body = json.loads(response["body"].decode("utf8"))
            except (ValueError, UnicodeError):
                body = None
            valid = isinstance(body, dict)
            if path.endswith("/live"):
                valid = valid and body.get("status") == "ok"
            elif path.endswith("/ready"):
                valid = valid and body.get("status") == "ready"
            else:
                expected_email = {"available": args.email_mode == "smtp",
                                  "delivery": "email" if args.email_mode == "smtp" else "disabled"}
                expected_phone = {"available": args.phone_available == "true", "region": "CN"}
                valid = valid and body.get("email") == expected_email and body.get("phone") == expected_phone
                valid = valid and "no-store" in response["headers"].get("Cache-Control", "").lower()
            check(origin + path, response["status"] == 200 and valid
                  and response["headers"].get("Content-Type", "").lower().startswith("application/json"),
                  status=response["status"], error=response.get("error"))
    print(json.dumps({"allReadOnlyChecksPassed": not failures, "failedChecks": failures,
        "GETRequests": len(urls), "expectedRelease": "duduhire-20260912-native-3",
        "acceptanceStillRequired": ["rendered UI and old service-worker browser update", "real Qwen discovery turn",
                                    "authorized SMS receipt and session lifecycle", "email delivery when enabled"],
        "authMethodsLimit": "Phone capability omits send deadline, remaining quota and recipient eligibility. SMTP availability does not prove delivery."}, sort_keys=True))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
PY
