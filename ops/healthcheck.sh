#!/usr/bin/env bash
set -euo pipefail
[[ $- != *x* ]] || { printf 'Disable shell tracing.\n' >&2; exit 2; }
[[ $# = 2 && $1 = --origin ]] || { printf 'Usage: bash ops/healthcheck.sh --origin https://duduhire.example.com\n' >&2; exit 2; }
origin=${2%/}
[[ $origin =~ ^https://[a-zA-Z0-9.-]+(:[0-9]+)?$ || $origin =~ ^http://(127\.0\.0\.1|localhost)(:[0-9]+)?$ ]] || { printf 'Use an HTTPS origin without a path, query, or credentials (loopback HTTP is allowed).\n' >&2; exit 2; }
status=0
command -v jq >/dev/null 2>&1 || { printf 'jq is required to validate API probe responses.\n' >&2; exit 2; }
for endpoint in /healthz /api/health/live /api/health/ready; do
  healthy=false
  if [[ $endpoint = /healthz ]]; then
    code=$(curl --silent --output /dev/null --write-out '%{http_code}' --connect-timeout 5 --max-time 10 "$origin$endpoint") || code=000
    [[ $code != 204 ]] || healthy=true
  else
    expected=ok
    [[ $endpoint != /api/health/ready ]] || expected=ready
    if curl --fail --silent --connect-timeout 5 --max-time 10 "$origin$endpoint" | jq -e --arg expected "$expected" 'type == "object" and .status == $expected' >/dev/null 2>&1; then healthy=true; fi
  fi
  if [[ $healthy = true ]]; then
    printf '{"endpoint":"%s","healthy":true}\n' "$endpoint"
  else
    printf '{"endpoint":"%s","healthy":false}\n' "$endpoint"
    status=1
  fi
done
exit "$status"
