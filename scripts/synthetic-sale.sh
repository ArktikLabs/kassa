#!/usr/bin/env bash
# Ring up a synthetic sale against production and ping the Better Stack
# heartbeat on success.
#
# Source issue: KASA-71. Companion: docs/RUNBOOK-ONCALL.md §4.
#
# Pilot-week observability requires that we exercise the full sales path
# (auth → submit → ledger write) every 15 min independent of real merchant
# traffic, so an outage in low-traffic windows pages on-call within 2 min
# rather than after the next manual sale. This script is the actual probe;
# the cadence comes from .github/workflows/synthetic-sale.yml.
#
# **Backend prerequisite (NOT YET LANDED).** The probe submits a sale with
# `tenders[].method = "synthetic"`. The API-side support for this tender —
# accepting the method, marking the row `synthetic = true`, excluding it
# from EOD totals while still writing a balancing ledger entry at EOD — is
# tracked under a child issue. Until that lands, this script is gated by
# the SYNTHETIC_PROBE_ENABLED repository variable and the workflow no-ops.
#
# Usage:
#   scripts/synthetic-sale.sh \
#     --api-url https://kassa-api-prod.fly.dev \
#     --device-token "$KASSA_SYNTHETIC_DEVICE_TOKEN" \
#     --outlet-id   "$KASSA_SYNTHETIC_OUTLET_ID" \
#     --item-id     "$KASSA_SYNTHETIC_ITEM_ID" \
#     [--heartbeat-url https://uptime.betterstack.com/api/v1/heartbeat/<token>]
#
# Exit codes:
#   0 — sale succeeded; heartbeat pinged (if URL provided).
#   1 — sale failed; heartbeat NOT pinged (Better Stack will page on missed window).
#   2 — usage / dependency error.

set -euo pipefail

API_URL=""
DEVICE_TOKEN=""
OUTLET_ID=""
ITEM_ID=""
HEARTBEAT_URL=""
TIMEOUT=15

err() { printf '%s\n' "$*" >&2; }

usage() {
  sed -n '/^# Usage:/,/^$/p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --api-url)        API_URL="${2:-}"; shift 2 ;;
    --device-token)   DEVICE_TOKEN="${2:-}"; shift 2 ;;
    --outlet-id)      OUTLET_ID="${2:-}"; shift 2 ;;
    --item-id)        ITEM_ID="${2:-}"; shift 2 ;;
    --heartbeat-url)  HEARTBEAT_URL="${2:-}"; shift 2 ;;
    --timeout)        TIMEOUT="${2:-}"; shift 2 ;;
    -h|--help)        usage ;;
    *) err "unknown flag: $1"; usage ;;
  esac
done

for flag in API_URL DEVICE_TOKEN OUTLET_ID ITEM_ID; do
  if [ -z "${!flag}" ]; then
    err "missing required flag for $flag"
    usage
  fi
done

command -v curl >/dev/null 2>&1 || { err "curl is required"; exit 2; }
command -v jq   >/dev/null 2>&1 || { err "jq is required"; exit 2; }

API_URL="${API_URL%/}"

# UUIDv7 generation: time-ordered, monotonic across rapid invocations. We
# avoid pulling a uuid binary by composing one from /proc/sys/kernel/random
# and a millisecond timestamp. Format: 8-4-4-4-12 hex with version=7,
# variant=10xx (RFC 9562 §6.10).
gen_uuid_v7() {
  local ms_hex rand_hex_a rand_hex_b
  ms_hex="$(printf '%012x' "$(($(date +%s%N) / 1000000))")"
  rand_hex_a="$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n' | head -c 16)"
  rand_hex_b="$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n' | head -c 16)"

  # Version = 7 in nibble 13; variant = 10xx in nibble 17.
  local p1 p2 p3 p4 p5
  p1="${ms_hex:0:8}"
  p2="${ms_hex:8:4}"
  # version nibble: replace first nibble of rand_hex_a with 7
  p3="7${rand_hex_a:1:3}"
  # variant nibble: top two bits = 10
  local var_nibble
  var_nibble="$(printf '%x' $(( (16#${rand_hex_a:4:1} & 3) | 8 )))"
  p4="${var_nibble}${rand_hex_a:5:3}"
  p5="${rand_hex_b:0:12}"

  printf '%s-%s-%s-%s-%s\n' "$p1" "$p2" "$p3" "$p4" "$p5"
}

LOCAL_SALE_ID="$(gen_uuid_v7)"
NOW_ISO="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
BUSINESS_DATE="$(date -u +%Y-%m-%d)"

# Fixed-price 1 IDR synthetic sale — deliberately low so EOD reconciliation
# arithmetic is unambiguous (and so a flapping probe can't accidentally
# inflate any real revenue figure if the tender filter regresses).
read -r -d '' BODY <<JSON || true
{
  "localSaleId": "$LOCAL_SALE_ID",
  "outletId": "$OUTLET_ID",
  "businessDate": "$BUSINESS_DATE",
  "occurredAt": "$NOW_ISO",
  "items": [
    { "itemId": "$ITEM_ID", "quantity": 1, "unitPriceIdr": 1 }
  ],
  "tenders": [
    { "method": "synthetic", "amountIdr": 1 }
  ]
}
JSON

printf 'POST %s/v1/sales/submit  localSaleId=%s\n' "$API_URL" "$LOCAL_SALE_ID"

http_status="$(curl -sS \
  -o /tmp/synthetic-sale.body \
  -w '%{http_code}' \
  --max-time "$TIMEOUT" \
  -X POST \
  -H "Authorization: Bearer $DEVICE_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$BODY" \
  "$API_URL/v1/sales/submit" || printf '000')"

if [ "$http_status" != "201" ] && [ "$http_status" != "409" ]; then
  err "synthetic sale FAILED — http=$http_status body=$(cat /tmp/synthetic-sale.body 2>/dev/null | head -c 500)"
  if [ "${GITHUB_ACTIONS:-false}" = "true" ]; then
    printf '::error title=Synthetic sale failed::http=%s — see job log for body\n' "$http_status"
  fi
  exit 1
fi

# 409 with the original-envelope shape is success on idempotency replay
# (the workflow scheduler may double-fire under cron drift).
printf 'synthetic sale OK — http=%s\n' "$http_status"

if [ -n "$HEARTBEAT_URL" ]; then
  printf 'pinging heartbeat...\n'
  if curl -fsS --max-time 10 "$HEARTBEAT_URL" >/dev/null; then
    printf 'heartbeat OK\n'
  else
    err "heartbeat ping FAILED — Better Stack will page on missed window."
    exit 1
  fi
fi
