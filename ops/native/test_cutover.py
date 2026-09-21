#!/usr/bin/env python3
"""Local synthetic configuration tests; never contact an API or invoke Nginx."""
from pathlib import Path
import tempfile
import unittest

import cutover


CONFIG = b"""# This is a synthetic fixture, not the real production configuration.
server {
    listen 80;
    server_name kylesong.top www.kylesong.top;
    return 301 https://$host$request_uri;
}
server {
    listen 443 ssl;
    server_name kylesong.top www.kylesong.top;
    ssl_certificate /synthetic/fullchain.pem;
    ssl_certificate_key /synthetic/privkey.pem;
    include /synthetic/tls-options.conf;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    root /var/www/kylesong;
    location / { try_files $uri $uri/ /index.html; }
}
server {
    listen 443 ssl;
    server_name api.kylesong.top;
    ssl_certificate /synthetic/fullchain.pem;
    ssl_certificate_key /synthetic/privkey.pem;
    location / { proxy_pass http://127.0.0.1:8787; }
}
server {
    listen 443 ssl;
    server_name unrelated.example;
    root /var/www/kylesong;
    location / { proxy_pass http://127.0.0.1:8787; }
}
"""


class CandidateTests(unittest.TestCase):
    def test_narrow_changes_preserve_tls_and_unrelated_servers(self):
        candidate, summary = cutover.candidate(CONFIG)
        self.assertIn(b"root /opt/duduhire/current/apps/web/dist;", candidate)
        self.assertEqual(summary["rootChanges"], 1)
        self.assertEqual(summary["upstreamChanges"], 1)
        self.assertEqual(candidate.count(b"proxy_pass http://127.0.0.1:8788;"), 2)
        self.assertEqual(candidate.count(b"proxy_pass http://127.0.0.1:8787;"), 1)
        self.assertIn(CONFIG[CONFIG.index(b"server {\n    listen 443 ssl;\n    server_name unrelated"):], candidate)
        for line in CONFIG.splitlines():
            if b"ssl_" in line or b"include " in line or b"Strict-Transport-Security" in line:
                self.assertIn(line, candidate)
        self.assertIn(b"location ^~ /api/", candidate)
        self.assertIn(b"location = /index.html", candidate)
        self.assertIn(b"location = /service-worker.js", candidate)
        self.assertIn(b"default_type application/javascript;", candidate)
        self.assertIn(b"expires -1;", candidate)
        self.assertEqual(candidate.count(b"add_header"), CONFIG.count(b"add_header"))
        self.assertEqual(summary["insertedLocations"], ["^~ /api/", "= /index.html", "= /service-worker.js"])

    def test_index_cache_route_preserves_server_headers_and_existing_asset_rules(self):
        assets = b"    location ~* \\.(html|css)$ { expires 7d; }\n"
        source = CONFIG.replace(b"    root /var/www/kylesong;", assets + b"    root /var/www/kylesong;", 1)
        rendered, _ = cutover.candidate(source)
        index = [node for node in cutover.walk(cutover.parse(rendered.decode()))
                 if node.words == ["location", "=", "/index.html"]]
        self.assertEqual(len(index), 1)
        self.assertEqual([node.words for node in index[0].children],
                         [["expires", "-1"], ["if_modified_since", "off"], ["etag", "off"]])
        self.assertIn(assets, rendered)
        self.assertIn(b"location / { try_files $uri $uri/ /index.html; }", rendered)
        self.assertEqual(rendered.count(b"add_header"), source.count(b"add_header"))

    def test_existing_exact_index_routes_require_review(self):
        routes = [
            b"location = /index.html { expires 7d; }",
            b"location =/index.html { expires 7d; }",
            b'location = "/index.html" { expires -1; if_modified_since off; etag off; }',
            b"location / { location = /index.html { expires 7d; } }",
        ]
        for route in routes:
            source = CONFIG.replace(b"    root /var/www/kylesong;", route + b"\n    root /var/www/kylesong;", 1)
            with self.subTest(route=route):
                with self.assertRaisesRegex(cutover.CutoverError, "Existing exact /index.html route"):
                    cutover.candidate(source)

    def test_parser_handles_quotes_comments_variables_and_crlf(self):
        source = CONFIG.replace(b"root /var/www/kylesong;", b'root "/var/www/kylesong"; # { ignored }\n    set $path "${host}/a;b";')
        rendered, _ = cutover.candidate(source.replace(b"\n", b"\r\n"))
        self.assertIn(b'set $path "${host}/a;b";', rendered)
        self.assertNotIn(b"\n", rendered.replace(b"\r\n", b""))

    def test_observed_worker_is_preserved_and_only_main_microphone_policy_changes(self):
        worker = b"""    location = /service-worker.js {
        expires -1;
        default_type application/javascript;
        try_files $uri =404;
    }
"""
        policy = b'    add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;\n'
        csp = b'    add_header Content-Security-Policy "default-src \'self\'; connect-src \'self\' https:; img-src \'self\' data:; script-src \'self\'" always;\n'
        source = CONFIG.replace(b"    root /var/www/kylesong;", policy + csp + worker + b"    root /var/www/kylesong;", 1)
        source = source.replace(b"    server_name api.kylesong.top;\n", b"    server_name api.kylesong.top;\n" + policy)
        rendered, summary = cutover.candidate(source)
        self.assertIn(worker, rendered)
        self.assertIn(csp, rendered)
        self.assertEqual(rendered.count(b"location = /service-worker.js"), 1)
        self.assertEqual(rendered.count(b'"camera=(), microphone=(self), geolocation=()"'), 1)
        self.assertEqual(rendered.count(b'"camera=(), microphone=(), geolocation=()"'), 1)
        self.assertTrue(summary["mainMicrophoneEnabled"])
        self.assertTrue(summary["existingWorkerPreserved"])
        self.assertEqual(summary["insertedLocations"], ["^~ /api/", "= /index.html"])
        self.assertTrue(summary["canonicalWwwRedirect"])
        self.assertIn(b"return 308 https://kylesong.top$request_uri;", rendered)

    def test_unknown_or_ambiguous_layouts_are_refused(self):
        cases = [
            CONFIG.replace(b"root /var/www/kylesong;", b"root /unexpected/root;", 1),
            CONFIG.replace(b"server_name kylesong.top www.kylesong.top;", b"server_name another.example;"),
            CONFIG.replace(b"root /var/www/kylesong;", b"root /var/www/kylesong;\n    location /api/ { proxy_pass http://other; }", 1),
            CONFIG.replace(b"root /var/www/kylesong;", b"root /var/www/kylesong;\n    location ~ ^/api { return 403; }", 1),
            CONFIG.replace(b"root /var/www/kylesong;", b"root /var/www/kylesong;\n    location = /service-worker.js { return 404; }", 1),
            CONFIG.replace(b"server_name api.kylesong.top;", b"server_name api.kylesong.top unrelated.example;"),
            CONFIG[:-3],
        ]
        for source in cases:
            with self.subTest(source=source[:40]):
                with self.assertRaises(cutover.CutoverError):
                    cutover.candidate(source)


class TransactionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="duduhire-cutover-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = self.root / "kylesong.conf"
        self.config.write_bytes(CONFIG)
        self.config.chmod(0o640)
        self.output = self.root / "plan"
        cutover.prepare(self.config, self.output)
        self.plan = self.output / "plan.json"

    def fake_nginx(self, outcomes):
        self.calls = []

        def run(binary, args, log):
            self.calls.append((binary, args, self.config.read_bytes()))
            cutover.private_write(log, b"synthetic Nginx result\n")
            return outcomes[len(self.calls) - 1]

        return run

    def test_prepare_never_changes_the_source_and_keeps_candidate_private(self):
        self.assertEqual(self.config.read_bytes(), CONFIG)
        self.assertEqual((self.output / "candidate.conf").stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.output.stat().st_mode & 0o777, 0o700)
        self.assertFalse((self.output / "original.conf").exists())

    def test_observed_copy_can_bind_a_plan_to_the_actual_target_path(self):
        import json
        output = self.root / "observed-plan"
        cutover.prepare(self.config, output, Path("/etc/nginx/conf.d/kylesong.conf"))
        plan = json.loads((output / "plan.json").read_text())
        self.assertEqual(plan["config"], "/etc/nginx/conf.d/kylesong.conf")
        self.assertEqual(plan["observedFrom"], str(self.config))
        self.assertEqual(plan["originalSha256"], cutover.sha256(CONFIG))

    def test_success_prechecks_before_write_and_preserves_mode(self):
        def ready():
            self.assertEqual(self.config.read_bytes(), CONFIG)
            self.assertFalse((self.output / "original.conf").exists())

        result = cutover.apply_plan(self.plan, check_ready=ready, run=self.fake_nginx([True, True]))
        self.assertEqual(result["status"], "applied")
        self.assertEqual((self.output / "original.conf").read_bytes(), CONFIG)
        self.assertEqual(self.config.read_bytes(), (self.output / "candidate.conf").read_bytes())
        self.assertEqual(self.config.stat().st_mode & 0o777, 0o640)
        self.assertEqual([args for _, args, _ in self.calls], [["-t"], ["-s", "reload"]])

    def test_readiness_failure_changes_nothing(self):
        def not_ready():
            raise cutover.CutoverError("synthetic not ready")

        with self.assertRaisesRegex(cutover.CutoverError, "not ready"):
            cutover.apply_plan(self.plan, check_ready=not_ready, run=self.fake_nginx([]))
        self.assertEqual(self.config.read_bytes(), CONFIG)
        self.assertFalse((self.output / "original.conf").exists())
        self.assertEqual(self.calls, [])

    def test_nginx_test_failure_restores_and_reloads_original(self):
        with self.assertRaisesRegex(cutover.CutoverError, "original configuration restored"):
            cutover.apply_plan(self.plan, check_ready=lambda: None, run=self.fake_nginx([False, True, True]))
        self.assertEqual(self.config.read_bytes(), CONFIG)
        self.assertEqual([args for _, args, _ in self.calls], [["-t"], ["-t"], ["-s", "reload"]])
        self.assertEqual(self.calls[-1][2], CONFIG)

    def test_reload_failure_restores_and_reloads_original(self):
        with self.assertRaisesRegex(cutover.CutoverError, "original configuration restored"):
            cutover.apply_plan(self.plan, check_ready=lambda: None, run=self.fake_nginx([True, False, True, True]))
        self.assertEqual(self.config.read_bytes(), CONFIG)
        self.assertEqual(self.calls[-1][2], CONFIG)

    def test_failed_rollback_is_not_reported_as_success(self):
        with self.assertRaisesRegex(cutover.CutoverError, "rollback needs operator attention"):
            cutover.apply_plan(self.plan, check_ready=lambda: None, run=self.fake_nginx([False, False]))
        self.assertEqual(self.config.read_bytes(), CONFIG)
        self.assertFalse((self.output / "result.json").exists())

    def test_changed_source_or_candidate_cannot_be_applied(self):
        for target in [self.config, self.output / "candidate.conf"]:
            original = target.read_bytes()
            target.write_bytes(original + b"# concurrent edit\n")
            with self.assertRaisesRegex(cutover.CutoverError, "changed after preparation"):
                cutover.apply_plan(self.plan, check_ready=lambda: self.fail("no precheck expected"), run=self.fake_nginx([]))
            target.write_bytes(original)
        self.assertFalse((self.output / "original.conf").exists())

    def test_existing_state_is_never_overwritten(self):
        with self.assertRaises(FileExistsError):
            cutover.prepare(self.config, self.output)
        cutover.apply_plan(self.plan, check_ready=lambda: None, run=self.fake_nginx([True, True]))
        self.config.write_bytes(CONFIG)
        with self.assertRaisesRegex(cutover.CutoverError, "already been attempted"):
            cutover.apply_plan(self.plan, check_ready=lambda: self.fail("no precheck expected"), run=self.fake_nginx([]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
