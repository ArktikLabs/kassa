#!/usr/bin/env bash
# Post-deployment smoke tests for Kassa — KASA-19.
#
# Exercises the three deployed surfaces (POS PWA, Back Office SPA, API) and
# verifies that the API reports the expected commit SHA in its /health payload.
# Intended to run as the final job in .github/workflows/cd.yml after every
# successful deploy; also runnable locally against any environment.
#
# Exit codes:
#   0 — every surface passed
#   1 — one or more surfaces failed (details printed to stderr)
#   2 — invalid usage / missing dependency
#
# A non-zero exit in CI surfaces as a failing workflow run, which is Kassa's
# primary alerting channel today (GitHub notifies assignees + @kassa-devops).
# Provider-side alerting (Better Stack, Sentry) is tracked under KASA-71.
#
# Usage:
#   scripts/deploy-smoke.sh \
#     --api-url https://kassa-api-staging.fly.dev \
#     --pos-url https://kassa-pos.pages.dev \
#     --back-office-url https://kassa-back-office.pages.dev \
#     --expected-version staging-abc123456789
#
# Flags:
#   --api-url URL             Base URL of the API (must expose /health). Required.
#   --pos-url URL             Base URL of the POS PWA. Required.
#   --back-office-url URL     Base URL of the Back Office SPA. Required.
#   --expected-version STR    If set, assert /health.version == STR.
#                             Omit for ad-hoc runs without a known SHA.
#   --attempts N              Retry attempts per surface (default 5).
#   --delay-seconds N         Sleep between retries (default 6).
#   --timeout-seconds N       Per-request timeout (default 10).

set -euo pipefail

API_URL=""
POS_URL=""
BACK_OFFICE_URL=""
EXPECTED_VERSION=""
ATTEMPTS=5
DELAY=6
REQ_TIMEOUT=10

err() { printf '%s\n' "$*" >&2; }

usage() {
  sed -n '/^# Usage:/,/^$/p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --api-url) API_URL="${2:-}"; shift 2 ;;
    --pos-url) POS_URL="${2:-}"; shift 2 ;;
    --back-office-url) BACK_OFFICE_URL="${2:-}"; shift 2 ;;
    --expected-version) EXPECTED_VERSION="${2:-}"; shift 2 ;;
    --attempts) ATTEMPTS="${2:-}"; shift 2 ;;
    --delay-seconds) DELAY="${2:-}"; shift 2 ;;
    --timeout-seconds) REQ_TIMEOUT="${2:-}"; shift 2 ;;
    -h|--help) usage ;;
    *) err "unknown flag: $1"; usage ;;
  esac
done

for flag in API_URL POS_URL BACK_OFFICE_URL; do
  if [ -z "${!flag}" ]; then
    err "missing required flag for $flag"
    usage
  fi
done

command -v curl >/dev/null 2>&1 || { err "curl is required"; exit 2; }

# Strip any trailing slashes for predictable URL concatenation.
API_URL="${API_URL%/}"
POS_URL="${POS_URL%/}"
BACK_OFFICE_URL="${BACK_OFFICE_URL%/}"

PASSED=()
FAILED=()

annotate_error() {
  # GitHub Actions picks up `::error::` annotations and surfaces them in the
  # run summary and PR checks. Safe no-op outside Actions.
  if [ "${GITHUB_ACTIONS:-false}" = "true" ]; then
    printf '::error title=%s::%s\n' "$1" "$2"
  fi
  err "FAIL: $1 — $2"
}

record_pass() {
  PASSED+=("$1")
  printf 'PASS: %s\n' "$1"
}

# Probe a URL until curl returns success AND `$validator` matches the body,
# or exit non-zero after $ATTEMPTS. Body is echoed on success for downstream
# assertions (e.g. version parsing).
probe() {
  local label="$1"
  local url="$2"
  local validator="$3"  # bash function name
  local body
  local attempt=1
  while [ "$attempt" -le "$ATTEMPTS" ]; do
    if body=$(curl -fsSL --max-time "$REQ_TIMEOUT" "$url" 2>/dev/null); then
      if "$validator" "$body"; then
        printf 'probe ok: %s (attempt %d)\n' "$label" "$attempt"
        printf '%s' "$body"
        return 0
      fi
    fi
    attempt=$((attempt + 1))
    if [ "$attempt" -le "$ATTEMPTS" ]; then
      sleep "$DELAY"
    fi
  done
  return 1
}

validate_api_health() {
  # Cheap JSON check — avoids a jq dependency on the runner. The API only
  # ever returns compact JSON here, so a substring match is safe.
  printf '%s' "$1" | grep -q '"status":"ok"'
}

validate_pos_html() {
  printf '%s' "$1" | grep -q '<title>Kassa POS</title>'
}

validate_back_office_html() {
  printf '%s' "$1" | grep -q '<title>Kassa Back Office</title>'
}

# ─── API /health ────────────────────────────────────────────────────────────
printf '\n== API /health (%s) ==\n' "$API_URL/health"
if health_body=$(probe "API /health" "$API_URL/health" validate_api_health); then
  record_pass "API /health"
  if [ -n "$EXPECTED_VERSION" ]; then
    # Parse version without requiring jq. Matches the "version":"..." field
    # written by apps/api/src/routes/health.ts.
    deployed_version=$(printf '%s' "$health_body" \
      | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')
    if [ "$deployed_version" = "$EXPECTED_VERSION" ]; then
      record_pass "API version == $EXPECTED_VERSION"
    else
      annotate_error "API version mismatch" \
        "expected '$EXPECTED_VERSION', got '${deployed_version:-<missing>}'. Deploy did not roll over or KASSA_API_VERSION was not injected."
      FAILED+=("API version")
    fi
  fi
else
  annotate_error "API /health unreachable" \
    "$API_URL/health did not return status=ok after $ATTEMPTS attempts"
  FAILED+=("API /health")
fi

# ─── POS PWA ────────────────────────────────────────────────────────────────
printf '\n== POS PWA (%s) ==\n' "$POS_URL/"
if probe "POS /" "$POS_URL/" validate_pos_html >/dev/null; then
  record_pass "POS /"
else
  annotate_error "POS unreachable" \
    "$POS_URL/ did not return the expected <title>Kassa POS</title> after $ATTEMPTS attempts"
  FAILED+=("POS /")
fi

# ─── Back Office SPA ────────────────────────────────────────────────────────
printf '\n== Back Office (%s) ==\n' "$BACK_OFFICE_URL/"
if probe "Back Office /" "$BACK_OFFICE_URL/" validate_back_office_html >/dev/null; then
  record_pass "Back Office /"
else
  annotate_error "Back Office unreachable" \
    "$BACK_OFFICE_URL/ did not return the expected <title>Kassa Back Office</title> after $ATTEMPTS attempts"
  FAILED+=("Back Office /")
fi

printf '\n== Summary ==\n'
printf 'passed: %d\n' "${#PASSED[@]}"
printf 'failed: %d\n' "${#FAILED[@]}"

if [ "${#FAILED[@]}" -gt 0 ]; then
  printf 'failures: %s\n' "${FAILED[*]}"
  exit 1
fi
