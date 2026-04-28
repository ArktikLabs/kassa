#!/usr/bin/env bash
# Apply Better Stack monitors + Sentry alert rules from infra/observability/*.json.
#
# Source issue: KASA-71. Companion: infra/observability/README.md.
#
# Default mode is DRY-RUN: the script prints what it would create, update, or
# leave unchanged based on the current SaaS state, but performs no mutations.
# Pass `--apply` to actually reconcile.
#
# Idempotent — safe to re-run. Records are matched by `pronounceable_name`
# (Better Stack) or `name` within `(organization, project)` (Sentry).
#
# Enablement gate (mirrors cd.yml / deploy-prod.yml):
#   The script no-ops with a `::notice::` if BETTER_STACK_API_TOKEN or
#   SENTRY_AUTH_TOKEN is unset. This lets the pre-provisioning window keep CI
#   green; the moment the operator sets the tokens, the next apply takes
#   effect.
#
# Usage:
#   scripts/observability-apply.sh                # dry-run
#   scripts/observability-apply.sh --apply        # apply
#   scripts/observability-apply.sh --apply --only better-stack   # only one provider
#   scripts/observability-apply.sh --apply --only sentry
#
# Exit codes:
#   0 — success (apply or dry-run completed)
#   1 — provider-side error (HTTP non-2xx, JSON parse failure)
#   2 — usage / dependency / config error

set -euo pipefail

APPLY="false"
ONLY="all"

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

err() { printf '%s\n' "$*" >&2; }
notice() {
  if [ "${GITHUB_ACTIONS:-false}" = "true" ]; then
    printf '::notice title=%s::%s\n' "$1" "$2"
  else
    printf '[notice] %s — %s\n' "$1" "$2"
  fi
}

usage() {
  sed -n '/^# Usage:/,/^$/p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY="true"; shift ;;
    --only) ONLY="${2:-}"; shift 2 ;;
    -h|--help) usage ;;
    *) err "unknown flag: $1"; usage ;;
  esac
done

case "$ONLY" in
  all|better-stack|sentry) ;;
  *) err "--only must be one of: all, better-stack, sentry"; exit 2 ;;
esac

command -v curl >/dev/null 2>&1 || { err "curl is required"; exit 2; }
command -v jq   >/dev/null 2>&1 || { err "jq is required (install with 'apt-get install jq' or 'brew install jq')"; exit 2; }

verb_for_apply() {
  if [ "$APPLY" = "true" ]; then printf 'APPLY'; else printf 'DRY-RUN'; fi
}

# ─── Better Stack ───────────────────────────────────────────────────────────
apply_better_stack() {
  if [ -z "${BETTER_STACK_API_TOKEN:-}" ]; then
    notice "Better Stack apply skipped" "BETTER_STACK_API_TOKEN is unset; provision per infra/observability/README.md."
    return 0
  fi

  local manifest="infra/observability/better-stack-monitors.json"
  if [ ! -f "$manifest" ]; then
    err "$manifest not found"; return 1
  fi

  printf '\n== Better Stack (%s) ==\n' "$(verb_for_apply)"

  # Strip _comment / _* annotations before sending. The local-only fields
  # exist for human readers; the API rejects unknown keys.
  local cleaned
  cleaned="$(jq 'walk(if type == "object" then with_entries(select(.key | startswith("_") | not)) else . end)' "$manifest")"

  # Index existing monitors by pronounceable_name so we can decide
  # create-vs-update without thrashing the API on every run.
  local existing
  existing="$(curl -fsS \
    -H "Authorization: Bearer $BETTER_STACK_API_TOKEN" \
    https://uptime.betterstack.com/api/v2/monitors)"
  local existing_index
  existing_index="$(printf '%s' "$existing" \
    | jq '[.data[] | { (.attributes.pronounceable_name): .id }] | add // {}')"

  printf '%s' "$cleaned" | jq -c '.monitors[]' | while read -r monitor; do
    local name id
    name="$(printf '%s' "$monitor" | jq -r '.pronounceable_name')"
    id="$(printf '%s' "$existing_index" | jq -r --arg n "$name" '.[$n] // ""')"

    if [ -n "$id" ]; then
      printf '  [update] monitor name=%s id=%s\n' "$name" "$id"
      if [ "$APPLY" = "true" ]; then
        curl -fsS \
          -X PATCH \
          -H "Authorization: Bearer $BETTER_STACK_API_TOKEN" \
          -H "Content-Type: application/json" \
          -d "$monitor" \
          "https://uptime.betterstack.com/api/v2/monitors/$id" >/dev/null
      fi
    else
      printf '  [create] monitor name=%s\n' "$name"
      if [ "$APPLY" = "true" ]; then
        curl -fsS \
          -X POST \
          -H "Authorization: Bearer $BETTER_STACK_API_TOKEN" \
          -H "Content-Type: application/json" \
          -d "$monitor" \
          https://uptime.betterstack.com/api/v2/monitors >/dev/null
      fi
    fi
  done

  # Heartbeats follow the same pattern, different endpoint.
  local existing_hb existing_hb_index
  existing_hb="$(curl -fsS \
    -H "Authorization: Bearer $BETTER_STACK_API_TOKEN" \
    https://uptime.betterstack.com/api/v2/heartbeats)"
  existing_hb_index="$(printf '%s' "$existing_hb" \
    | jq '[.data[] | { (.attributes.pronounceable_name): .id }] | add // {}')"

  printf '%s' "$cleaned" | jq -c '.heartbeats[]?' | while read -r hb; do
    local name id
    name="$(printf '%s' "$hb" | jq -r '.pronounceable_name')"
    id="$(printf '%s' "$existing_hb_index" | jq -r --arg n "$name" '.[$n] // ""')"
    if [ -n "$id" ]; then
      printf '  [update] heartbeat name=%s id=%s\n' "$name" "$id"
      if [ "$APPLY" = "true" ]; then
        curl -fsS \
          -X PATCH \
          -H "Authorization: Bearer $BETTER_STACK_API_TOKEN" \
          -H "Content-Type: application/json" \
          -d "$hb" \
          "https://uptime.betterstack.com/api/v2/heartbeats/$id" >/dev/null
      fi
    else
      printf '  [create] heartbeat name=%s\n' "$name"
      if [ "$APPLY" = "true" ]; then
        curl -fsS \
          -X POST \
          -H "Authorization: Bearer $BETTER_STACK_API_TOKEN" \
          -H "Content-Type: application/json" \
          -d "$hb" \
          https://uptime.betterstack.com/api/v2/heartbeats >/dev/null
      fi
    fi
  done
}

# ─── Sentry ─────────────────────────────────────────────────────────────────
apply_sentry() {
  if [ -z "${SENTRY_AUTH_TOKEN:-}" ]; then
    notice "Sentry apply skipped" "SENTRY_AUTH_TOKEN is unset; provision per infra/observability/README.md."
    return 0
  fi
  local org="${SENTRY_ORG:-kassa}"

  local manifest="infra/observability/sentry-alert-rules.json"
  if [ ! -f "$manifest" ]; then
    err "$manifest not found"; return 1
  fi

  printf '\n== Sentry (%s) ==\n' "$(verb_for_apply)"

  local cleaned
  cleaned="$(jq 'walk(if type == "object" then with_entries(select(.key | startswith("_") | not)) else . end)' "$manifest")"

  # Substitute ${SENTRY_*} variable references in project_slug fields.
  local resolved
  resolved="$(printf '%s' "$cleaned" \
    | sed \
        -e "s|\${SENTRY_ORG}|${SENTRY_ORG:-kassa}|g" \
        -e "s|\${SENTRY_PROJECT_API}|${SENTRY_PROJECT_API:-kassa-api}|g" \
        -e "s|\${SENTRY_PROJECT_POS}|${SENTRY_PROJECT_POS:-kassa-pos}|g" \
        -e "s|\${SENTRY_PROJECT_BACK_OFFICE}|${SENTRY_PROJECT_BACK_OFFICE:-kassa-back-office}|g")"

  printf '%s' "$resolved" | jq -c '.rules[]' | while read -r rule; do
    local name kind project endpoint existing id
    name="$(printf '%s' "$rule" | jq -r '.name')"
    kind="$(printf '%s' "$rule" | jq -r '.kind')"
    project="$(printf '%s' "$rule" | jq -r '.project_slug')"

    case "$kind" in
      issue)  endpoint="https://sentry.io/api/0/projects/$org/$project/rules/" ;;
      metric) endpoint="https://sentry.io/api/0/organizations/$org/alert-rules/" ;;
      *) err "unknown rule kind: $kind"; continue ;;
    esac

    existing="$(curl -fsS \
      -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" \
      "$endpoint" | jq --arg n "$name" '[.[] | select(.name == $n)]')"
    id="$(printf '%s' "$existing" | jq -r '.[0].id // ""')"

    if [ -n "$id" ]; then
      printf '  [update] %-6s rule project=%s name=%s id=%s\n' "$kind" "$project" "$name" "$id"
      if [ "$APPLY" = "true" ]; then
        case "$kind" in
          issue)
            curl -fsS \
              -X PUT \
              -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" \
              -H "Content-Type: application/json" \
              -d "$rule" \
              "https://sentry.io/api/0/projects/$org/$project/rules/$id/" >/dev/null
            ;;
          metric)
            curl -fsS \
              -X PUT \
              -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" \
              -H "Content-Type: application/json" \
              -d "$rule" \
              "https://sentry.io/api/0/organizations/$org/alert-rules/$id/" >/dev/null
            ;;
        esac
      fi
    else
      printf '  [create] %-6s rule project=%s name=%s\n' "$kind" "$project" "$name"
      if [ "$APPLY" = "true" ]; then
        curl -fsS \
          -X POST \
          -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" \
          -H "Content-Type: application/json" \
          -d "$rule" \
          "$endpoint" >/dev/null
      fi
    fi
  done
}

case "$ONLY" in
  all)
    apply_better_stack
    apply_sentry
    ;;
  better-stack) apply_better_stack ;;
  sentry)       apply_sentry ;;
esac

printf '\nDone (%s).\n' "$(verb_for_apply)"
