#!/usr/bin/env bash
set -euo pipefail

MINUTES="${1:-5}"
case "$MINUTES" in
  ''|*[!0-9]*) echo "usage: $0 [minutes]" >&2; exit 2 ;;
esac

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="${TMPDIR:-/tmp}/forgerelay-retry-${STAMP}"
mkdir -p "$OUT"
chmod 700 "$OUT"

redact() {
  sed -E \
    -e 's/(Bearer[[:space:]]+)[A-Za-z0-9._~+\/-]+/\1[REDACTED]/g' \
    -e 's/((token|secret|password|authorization)[=:][[:space:]]*)[^ ,;]+/\1[REDACTED]/Ig'
}

{
  echo "captured_at=$(date -Is)"
  echo "window_minutes=$MINUTES"
  echo "hostname=$(hostname)"
  echo "forgerelay_version=$(/srv/workspace/.tools/forgerelay/node_modules/.bin/forgerelay --version 2>/dev/null || echo unknown)"
  echo
  systemctl --user show forgerelay.service \
    -p ActiveState -p SubState -p Result -p NRestarts -p ExecMainPID -p ActiveEnterTimestamp 2>&1 || true
  echo
  uptime
  free -h
  echo
  ss -ltnp 2>/dev/null | grep -E ':(7676|7677|7678)\b' || true
} | redact > "$OUT/summary.txt"

journalctl --user -u forgerelay.service --since "$MINUTES minutes ago" --no-pager -o short-iso 2>&1 \
  | redact > "$OUT/forgerelay.log"

journalctl --user -u dashboard-cloudflared.service --since "$MINUTES minutes ago" --no-pager -o short-iso 2>&1 \
  | redact > "$OUT/cloudflared-user.log" || true

journalctl -u cloudflared.service --since "$MINUTES minutes ago" --no-pager -o short-iso 2>&1 \
  | redact > "$OUT/cloudflared-system.log" || true

journalctl --since "$MINUTES minutes ago" --no-pager -o short-iso 2>&1 \
  | grep -Ei 'oom|out of memory|killed process|segfault|NVRM|Xid|watchdog|thermal|overheat|connection reset|network.*(down|unreachable)' \
  | redact > "$OUT/system-risk.log" || true

{
  echo "# Public endpoint probes"
  for i in $(seq 1 10); do
    curl -sS -o /dev/null --max-time 8 \
      -w "$i code=%{http_code} dns=%{time_namelookup} connect=%{time_connect} tls=%{time_appconnect} ttfb=%{time_starttransfer} total=%{time_total}\n" \
      https://forgerelay.nancyai.dev/mcp || echo "$i curl_failed"
  done
} > "$OUT/network-probes.txt" 2>&1

{
  echo "# MCP / App lifecycle highlights"
  grep -Ei 'mcp |http .* /mcp|resources/read|mcp-app|asset|activity_panel|AfterToolFailure|timeout|timed out|error|warn' \
    "$OUT/forgerelay.log" || true
} > "$OUT/highlights.txt"

resource_reads=$(grep -c 'resources/read' "$OUT/forgerelay.log" 2>/dev/null || true)
asset_fetches=$(grep -c 'mcp-app-assets' "$OUT/forgerelay.log" 2>/dev/null || true)
http_failures=$(grep -Ec 'http .* /mcp -> (408|429|5[0-9][0-9])' "$OUT/forgerelay.log" 2>/dev/null || true)
service_restarts=$(grep -Ec 'Starting forgerelay|Stopped forgerelay|Main process exited|Failed with result' "$OUT/forgerelay.log" 2>/dev/null || true)

classification="inconclusive"
if [ "$service_restarts" -gt 0 ]; then
  classification="forgerelay-runtime-instability"
elif [ "$resource_reads" -gt 0 ] && [ "$asset_fetches" -eq 0 ]; then
  classification="host-renderer-before-asset-fetch"
elif [ "$resource_reads" -gt 0 ] && [ "$asset_fetches" -gt 0 ] && [ "$http_failures" -eq 0 ]; then
  classification="host-renderer-after-asset-fetch-or-ui-layer"
elif [ "$http_failures" -gt 0 ]; then
  classification="mcp-transport-or-resource-http-failure"
fi

{
  echo "classification=$classification"
  echo "resources_read_count=$resource_reads"
  echo "asset_fetch_count=$asset_fetches"
  echo "mcp_http_failure_count=$http_failures"
  echo "service_restart_signal_count=$service_restarts"
} > "$OUT/diagnosis.txt"

tar -C "$(dirname "$OUT")" -czf "${OUT}.tar.gz" "$(basename "$OUT")"
chmod 600 "${OUT}.tar.gz"

echo "snapshot_dir=$OUT"
echo "snapshot_archive=${OUT}.tar.gz"
echo "highlights=$OUT/highlights.txt"
