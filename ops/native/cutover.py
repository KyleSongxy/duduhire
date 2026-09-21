#!/usr/bin/env python3
"""Prepare a narrow Nginx candidate; apply only after an explicit CLI action.

This program never modifies application files, databases, TLS directives, or the
current release symlink. Preparing a plan does not run Nginx or contact an API.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import tempfile
import urllib.request


OLD_ROOT = "/var/www/kylesong"
NEW_ROOT = "/opt/duduhire/current/apps/web/dist"
OLD_UPSTREAM = "http://127.0.0.1:8787"
NEW_UPSTREAM = "http://127.0.0.1:8788"
MAIN_HOST = "kylesong.top"
RELATED_HOSTS = {MAIN_HOST, "www.kylesong.top", "api.kylesong.top"}


class CutoverError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise CutoverError(message)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


class Token:
    def __init__(self, value, start, end, structural=False):
        self.value = value
        self.start = start
        self.end = end
        self.structural = structural


class Directive:
    def __init__(self, header, start, end, close=None, children=None):
        self.header = header
        self.start = start
        self.end = end
        self.close = close
        self.children = children

    @property
    def words(self):
        return [token.value for token in self.header]


def lex(text):
    tokens = []
    index = 0
    while index < len(text):
        if text[index].isspace():
            index += 1
            continue
        if text[index] == "#":
            end = text.find("\n", index)
            index = len(text) if end < 0 else end + 1
            continue
        start = index
        if text[index] in "{};":
            tokens.append(Token(text[index], start, start + 1, True))
            index += 1
            continue
        value = []
        while index < len(text) and not text[index].isspace() and text[index] not in "{};#":
            char = text[index]
            if char in "\"'":
                quote = char
                index += 1
                while index < len(text) and text[index] != quote:
                    if text[index] == "\\":
                        index += 1
                        require(index < len(text), "Unterminated quoted escape")
                    value.append(text[index])
                    index += 1
                require(index < len(text), "Unterminated quoted string")
                index += 1
            elif char == "\\":
                index += 1
                require(index < len(text), "Unterminated escape")
                value.append(text[index])
                index += 1
            elif text.startswith("${", index):
                end = text.find("}", index + 2)
                require(end >= 0, "Unterminated Nginx variable")
                value.append(text[index:end + 1])
                index = end + 1
            else:
                value.append(char)
                index += 1
        require(index > start, "Unrecognized Nginx token")
        tokens.append(Token("".join(value), start, index))
    return tokens


def parse(text):
    tokens = lex(text)
    index = 0

    def block(expect_close=False):
        nonlocal index
        directives = []
        while index < len(tokens):
            if tokens[index].structural and tokens[index].value == "}":
                require(expect_close, "Unexpected closing brace")
                closing = tokens[index]
                index += 1
                return directives, closing
            header = []
            while index < len(tokens) and not tokens[index].structural:
                header.append(tokens[index])
                index += 1
            require(header and index < len(tokens), "Incomplete Nginx directive")
            terminal = tokens[index]
            index += 1
            if terminal.value == ";":
                directives.append(Directive(header, header[0].start, terminal.end))
            elif terminal.value == "{":
                children, closing = block(True)
                directives.append(Directive(header, header[0].start, closing.end, closing.start, children))
            else:
                raise CutoverError("Unexpected directive terminator")
        require(not expect_close, "Missing closing brace")
        return directives, None

    return block()[0]


def walk(nodes):
    for node in nodes:
        yield node
        yield from walk(node.children or [])


def candidate(source):
    """Fail closed on unknown roots or route layouts; preserve all other bytes."""
    text = source.decode("utf-8")
    parsed = parse(text)
    servers = [node for node in walk(parsed) if node.words == ["server"] and node.children is not None]
    named = []
    for server in servers:
        names = {word for child in server.children if child.words[0] == "server_name" for word in child.words[1:]}
        named.append((server, names))
    main = []
    for server, names in named:
        listens = [child.words[1:] for child in server.children if child.words[0] == "listen"]
        if MAIN_HOST in names and any("ssl" in words for words in listens):
            main.append(server)
    require(len(main) == 1, "Expected exactly one explicit kylesong.top HTTPS server; inspect the actual configuration")
    main_server = main[0]
    main_names = next(names for server, names in named if server is main_server)
    roots = [node for node in walk(main_server.children) if node.words[0] == "root"]
    require(len(roots) == 1 and roots[0] in main_server.children and roots[0].words == ["root", OLD_ROOT],
            "Expected one direct main-server root /var/www/kylesong; inspect the actual configuration")
    edits = [(roots[0].header[1].start, roots[0].header[1].end, NEW_ROOT)]
    policies = [node for node in main_server.children if node.words[:2] == ["add_header", "Permissions-Policy"]]
    require(len(policies) <= 1, "Multiple main-domain Permissions-Policy headers require review")
    microphone_change = False
    if policies:
        policy = policies[0]
        require(len(policy.header) in (3, 4) and policy.words[2] in (
            "camera=(), microphone=(), geolocation=()", "camera=(), microphone=(self), geolocation=()"),
            "Unknown main-domain Permissions-Policy requires review")
        if policy.words[2] == "camera=(), microphone=(), geolocation=()":
            token = policy.header[2]
            value = text[token.start:token.end].replace("microphone=()", "microphone=(self)")
            edits.append((token.start, token.end, value))
            microphone_change = True
    upstream_replacements = 0
    for server, names in named:
        if not (names & RELATED_HOSTS):
            continue
        require(names <= RELATED_HOSTS, "Target server also handles an unrelated hostname; review before cutover")
        for node in walk(server.children):
            if node.words[0] != "proxy_pass":
                continue
            require(len(node.header) == 2, "Unexpected proxy_pass syntax")
            value = node.header[1].value
            if value == OLD_UPSTREAM or value.startswith(OLD_UPSTREAM + "/"):
                edits.append((node.header[1].start, node.header[1].end, NEW_UPSTREAM + value[len(OLD_UPSTREAM):]))
                upstream_replacements += 1

    locations = [node for node in main_server.children if node.words[0] == "location"]
    api_locations = [node for node in locations if node.words[1:] in [["/api/"], ["^~", "/api/"], ["/api"], ["^~", "/api"]]]
    api_other = [node for node in locations if "api" in " ".join(node.words[1:]) and node not in api_locations]
    require(not api_other and len(api_locations) <= 1, "Ambiguous main-domain API locations; inspect the actual configuration")
    newline = "\r\n" if "\r\n" in text else "\n"
    api_block = """location ^~ /api/ {
        client_max_body_size 320k;
        proxy_pass http://127.0.0.1:8788;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_connect_timeout 5s;
        proxy_send_timeout 45s;
        proxy_read_timeout 60s;
    }""".replace("\n", newline)
    require(not api_locations, "Existing main-domain API route requires review; this candidate only inserts a missing route")

    index_locations = [node for node in walk(main_server.children) if node.words[0] == "location"
                       and node.words[1:] in [["=", "/index.html"], ["=/index.html"]]]
    require(not index_locations, "Existing exact /index.html route requires review; this candidate only inserts a missing route")
    # Exact matching also covers SPA fallback redirects and avoids inherited
    # asset-cache rules. Do not add location headers that replace server headers.
    index_block = """location = /index.html {
        expires -1;
        if_modified_since off;
        etag off;
    }""".replace("\n", newline)

    worker_locations = [node for node in locations if any("service-worker" in word for word in node.words[1:])]
    require(len(worker_locations) <= 1, "Multiple service-worker locations require review")
    if worker_locations:
        worker = worker_locations[0]
        require(worker.words == ["location", "=", "/service-worker.js"]
                and worker.children is not None and len(worker.children) == 3
                and all(node.children is None for node in worker.children)
                and {tuple(node.words) for node in worker.children} == {
                    ("expires", "-1"), ("default_type", "application/javascript"), ("try_files", "$uri", "=404"),
                }, "Existing service-worker route differs from the observed no-cache/JavaScript/file-only route")
    # expires -1 emits Cache-Control: no-cache without add_header, preserving the
    # existing server's HSTS/security-header inheritance.
    worker_block = """location = /service-worker.js {
        types { }
        default_type application/javascript;
        expires -1;
        try_files $uri =404;
    }""".replace("\n", newline)
    additions = [api_block, index_block]
    if not worker_locations:
        additions.append(worker_block)
    canonical_redirect = "www.kylesong.top" in main_names
    if canonical_redirect:
        require(not any(node.words[0] == "if" and "www.kylesong.top" in " ".join(node.words[1:])
                        for node in main_server.children), "Existing www redirect requires review")
        additions.append("""# Auth cookies and Origin checks use the canonical HTTPS origin.
    if ($host = www.kylesong.top) {
        return 308 https://kylesong.top$request_uri;
    }""".replace("\n", newline))
    addition = newline + (newline + newline).join("    " + item for item in additions) + newline
    edits.append((main_server.close, main_server.close, addition))
    for start, end, value in sorted(edits, reverse=True):
        text = text[:start] + value + text[end:]
    parse(text)
    return text.encode("utf-8"), {
        "mainHost": MAIN_HOST, "rootChanges": 1, "upstreamChanges": upstream_replacements,
        "insertedLocations": ["^~ /api/", "= /index.html"] + ([] if worker_locations else ["= /service-worker.js"]),
        "existingWorkerPreserved": bool(worker_locations), "mainMicrophoneEnabled": microphone_change,
        "canonicalWwwRedirect": canonical_redirect,
        "mainServerIncludes": [child.words[1:] for child in main_server.children if child.words[0] == "include"],
        "review": "Review the candidate and included files against the actual server before applying",
    }


def regular_file(path):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, "Expected a regular non-symlink, non-hard-linked file: " + str(path))
    return info


def private_write(path, content):
    with path.open("xb") as stream:
        os.fchmod(stream.fileno(), 0o600)
        stream.write(content)


def write_json(path, value):
    private_write(path, (json.dumps(value, indent=2) + "\n").encode())


def prepare(config_path, output, target_config=None):
    target_config = target_config or config_path
    require(config_path.is_absolute() and output.is_absolute() and target_config.is_absolute(), "Config, target and output paths must be absolute")
    regular_file(config_path)
    source = config_path.read_bytes()
    rendered, summary = candidate(source)
    output.mkdir(mode=0o700, parents=False, exist_ok=False)
    private_write(output / "candidate.conf", rendered)
    write_json(output / "plan.json", {
        "schemaVersion": 1, "config": str(target_config), "observedFrom": str(config_path), "originalSha256": sha256(source),
        "candidateSha256": sha256(rendered), **summary,
    })
    return {"status": "prepared_only", "plan": str(output / "plan.json"), "candidate": str(output / "candidate.conf"), **summary}


def precheck():
    for filename in ["index.html", "service-worker.js"]:
        require((Path(NEW_ROOT) / filename).is_file(), "New Web release is incomplete: " + filename)

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, request, *args):
            raise CutoverError("API readiness redirected unexpectedly")

    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(NEW_UPSTREAM + "/api/health/ready", timeout=5) as response:
            body = response.read(4097)
            require(response.status == 200 and len(body) <= 4096 and json.loads(body) == {"status": "ready"},
                    "New API readiness is not ready")
    except (OSError, ValueError) as error:
        raise CutoverError("New API readiness failed; configuration was not changed") from error


def replace_file(path, content, info):
    descriptor, temporary = tempfile.mkstemp(prefix=".duduhire-cutover-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            os.fchmod(stream.fileno(), stat.S_IMODE(info.st_mode))
            os.fchown(stream.fileno(), info.st_uid, info.st_gid)
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def nginx_run(binary, args, log_path):
    try:
        result = subprocess.run([binary, *args], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=30, check=False)
        private_write(log_path, result.stdout)
        return result.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        private_write(log_path, b"Nginx command failed to execute or timed out; no raw exception recorded.\n")
        return False


def apply_plan(plan_path, nginx="/usr/sbin/nginx", check_ready=precheck, run=nginx_run):
    require(plan_path.is_absolute() and Path(nginx).is_absolute(), "Plan and Nginx paths must be absolute")
    regular_file(plan_path)
    plan = json.loads(plan_path.read_text())
    require(plan.get("schemaVersion") == 1, "Unsupported plan version")
    config_path = Path(plan["config"])
    require(config_path.is_absolute(), "Plan config path must be absolute")
    directory = plan_path.parent
    regular_file(directory / "candidate.conf")
    lock_path = config_path.parent / ("." + config_path.name + ".duduhire-cutover.lock")
    descriptor = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        info = regular_file(config_path)
        source = config_path.read_bytes()
        require(sha256(source) == plan["originalSha256"], "Original configuration changed after preparation; create a fresh plan")
        rendered = (directory / "candidate.conf").read_bytes()
        expected, _ = candidate(source)
        require(rendered == expected and sha256(rendered) == plan["candidateSha256"], "Candidate changed after preparation")
        require(not (directory / "original.conf").exists(), "This plan has already been attempted; use a fresh plan")
        check_ready()
        private_write(directory / "original.conf", source)
        write_json(directory / "original-metadata.json", {"mode": stat.S_IMODE(info.st_mode), "uid": info.st_uid, "gid": info.st_gid, "sha256": sha256(source)})
        changed = False
        try:
            # Recheck immediately before the atomic write to detect other editors.
            require(config_path.read_bytes() == source, "Configuration changed during prechecks")
            changed = True
            replace_file(config_path, rendered, info)
            require(run(nginx, ["-t"], directory / "candidate-test.log"), "Candidate nginx -t failed")
            require(run(nginx, ["-s", "reload"], directory / "candidate-reload.log"), "Candidate Nginx reload failed")
            write_json(directory / "result.json", {"status": "applied", "configSha256": sha256(rendered), "backup": str(directory / "original.conf")})
        except BaseException as error:
            if changed:
                try:
                    replace_file(config_path, source, info)
                    tested = run(nginx, ["-t"], directory / "rollback-test.log")
                    reloaded = tested and run(nginx, ["-s", "reload"], directory / "rollback-reload.log")
                    require(tested and reloaded, "Old configuration restored but rollback validation/reload failed")
                except BaseException as rollback_error:
                    raise CutoverError("Cutover failed and rollback needs operator attention; inspect protected plan logs") from rollback_error
                raise CutoverError("Cutover failed; original configuration restored, tested and reloaded") from error
            raise
    return {"status": "applied", "config": str(config_path), "backup": str(directory / "original.conf"),
            "acceptance": "Local readiness and Nginx test/reload passed; public HTTPS, auth, Web and service-worker acceptance remain required"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command")
    # The required keyword for add_subparsers was added after Python 3.6.
    commands.required = True
    preparing = commands.add_parser("prepare", help="Only generate a reviewed candidate and hash-bound plan")
    preparing.add_argument("--config", type=Path, default=Path("/etc/nginx/conf.d/kylesong.conf"))
    preparing.add_argument("--target-config", type=Path, help="Actual configuration path when --config is an observed local copy; apply still requires the same original SHA256")
    preparing.add_argument("--output", type=Path, required=True, help="New directory under an existing protected parent")
    applying = commands.add_parser("apply", help="Check readiness, back up, test, reload, and roll back on failure")
    applying.add_argument("--plan", type=Path, required=True)
    applying.add_argument("--nginx", default="/usr/sbin/nginx")
    applying.add_argument("--confirm", choices=["APPLY"], required=True)
    args = parser.parse_args()
    if args.command == "prepare":
        result = prepare(args.config, args.output, args.target_config)
    else:
        def interrupted(_signum, _frame):
            raise InterruptedError("Cutover interrupted")
        signal.signal(signal.SIGTERM, interrupted)
        signal.signal(signal.SIGHUP, interrupted)
        result = apply_plan(args.plan, args.nginx)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (CutoverError, OSError, ValueError, KeyError) as error:
        # Never dump candidate directives or subprocess output into a shared terminal.
        message = str(error) if isinstance(error, CutoverError) else "Cutover could not complete; inspect paths, permissions and the protected plan"
        print(json.dumps({"status": "failed", "message": message}), file=sys.stderr)
        sys.exit(1)
