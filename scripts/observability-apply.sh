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

# ─── Sentry alert rules ─────────────────────────────────────────────────────
#
# Two endpoint shapes share the alert-rule manifest:
#
#   kind: issue   → POST /projects/{org}/{project}/rules/   (project-rule schema)
#   kind: metric  → POST /organizations/{org}/alert-rules/  (metric-alert envelope)
#
# The metric-alert envelope expects `projects: [<slug>]` at the top level, plus
# `triggers: [{ label, alertThreshold, actions: [...] }]` and the threshold/
# window fields in camelCase. Sending the flat manifest body to the metric
# endpoint produces a 400. This function builds the envelope by lifting
# `project_slug` into `projects[]` and dropping local routing keys (`kind`,
# `project_slug`, `organization_slug`) before POSTing. See KASA-153.
apply_sentry() {
  local org="${SENTRY_ORG:-kassa}"

  local manifest="infra/observability/sentry-alert-rules.json"
  if [ ! -f "$manifest" ]; then
    err "$manifest not found"; return 1
  fi

  local has_token="false"
  if [ -n "${SENTRY_AUTH_TOKEN:-}" ]; then
    has_token="true"
  else
    notice "Sentry apply skipped" "SENTRY_AUTH_TOKEN is unset; printing the resolved payloads but making no network calls. Provision per infra/observability/README.md."
  fi

  printf '\n== Sentry (%s) ==\n' "$(verb_for_apply)"

  local cleaned
  cleaned="$(jq 'walk(if type == "object" then with_entries(select(.key | startswith("_") | not)) else . end)' "$manifest")"

  # Substitute ${SENTRY_*} placeholders. Defaults match the runbook §3.1
  # provisioning checklist; the integration / team IDs have no sane default,
  # so an unset env var leaves a tagged sentinel that surfaces as a clear 400
  # ("invalid integrationId: PROVISION_PER_RUNBOOK_3_1") rather than silent
  # routing to the wrong destination.
  local resolved
  resolved="$(printf '%s' "$cleaned" \
    | sed \
        -e "s|\${SENTRY_ORG}|${SENTRY_ORG:-kassa}|g" \
        -e "s|\${SENTRY_PROJECT_API}|${SENTRY_PROJECT_API:-kassa-api}|g" \
        -e "s|\${SENTRY_PROJECT_POS}|${SENTRY_PROJECT_POS:-kassa-pos}|g" \
        -e "s|\${SENTRY_PROJECT_BACK_OFFICE}|${SENTRY_PROJECT_BACK_OFFICE:-kassa-back-office}|g" \
        -e "s|\${SENTRY_SLACK_INTEGRATION_ID}|${SENTRY_SLACK_INTEGRATION_ID:-PROVISION_PER_RUNBOOK_3_1}|g" \
        -e "s|\${SENTRY_ONCALL_TEAM_ID}|${SENTRY_ONCALL_TEAM_ID:-PROVISION_PER_RUNBOOK_3_1}|g")"

  printf '%s' "$resolved" | jq -c '.rules[]' | while read -r rule; do
    local name kind project create_endpoint list_endpoint update_endpoint_prefix payload existing id
    name="$(printf '%s' "$rule" | jq -r '.name')"
    kind="$(printf '%s' "$rule" | jq -r '.kind')"
    project="$(printf '%s' "$rule" | jq -r '.project_slug')"

    case "$kind" in
      issue)
        create_endpoint="https://sentry.io/api/0/projects/$org/$project/rules/"
        list_endpoint="$create_endpoint"
        update_endpoint_prefix="https://sentry.io/api/0/projects/$org/$project/rules/"
        # Project-rule schema (kind: issue) is sent as-is — out of scope for
        # KASA-153 — minus the local routing keys.
        payload="$(printf '%s' "$rule" | jq 'del(.kind, .project_slug, .organization_slug)')"
        ;;
      metric)
        create_endpoint="https://sentry.io/api/0/organizations/$org/alert-rules/"
        # Org-scoped metric-alert listing; filter by project so we don't
        # collide with same-named rules in sibling projects.
        list_endpoint="https://sentry.io/api/0/organizations/$org/alert-rules/?project=$project"
        update_endpoint_prefix="https://sentry.io/api/0/organizations/$org/alert-rules/"
        # Lift project_slug into projects[]; drop local routing keys.
        payload="$(printf '%s' "$rule" | jq --arg p "$project" 'del(.kind, .project_slug, .organization_slug) | . + {projects: [$p]}')"
        ;;
      *) err "unknown rule kind: $kind"; continue ;;
    esac

    if [ "$has_token" = "false" ]; then
      printf '  [would-send] %-6s rule project=%s name=%s payload=\n' "$kind" "$project" "$name"
      printf '%s\n' "$payload" | jq .
      continue
    fi

    existing="$(curl -fsS \
      -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" \
      "$list_endpoint" | jq --arg n "$name" '[.[] | select(.name == $n)]')"
    id="$(printf '%s' "$existing" | jq -r '.[0].id // ""')"

    if [ -n "$id" ]; then
      printf '  [update] %-6s rule project=%s name=%s id=%s\n' "$kind" "$project" "$name" "$id"
      if [ "$APPLY" = "true" ]; then
        curl -fsS \
          -X PUT \
          -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" \
          -H "Content-Type: application/json" \
          -d "$payload" \
          "${update_endpoint_prefix}${id}/" >/dev/null
      fi
    else
      printf '  [create] %-6s rule project=%s name=%s\n' "$kind" "$project" "$name"
      if [ "$APPLY" = "true" ]; then
        curl -fsS \
          -X POST \
          -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" \
          -H "Content-Type: application/json" \
          -d "$payload" \
          "$create_endpoint" >/dev/null
      fi
    fi
  done
}

# ─── Sentry dashboards ──────────────────────────────────────────────────────
#
# Sentry's dashboards-v2 API takes a flat envelope with `title`, `widgets[]`,
# and (optionally) `projects: [<id>]` + `period`. The list endpoint returns
# numeric ids per dashboard plus the `title` we match on as the idempotency
# key. `project_slug` is a local routing key — the apply script keeps the
# slug-name form in the manifest for readability and (when a token is
# present) resolves it against the org's project list to a numeric id, which
# is what Sentry actually requires in `projects: []`. Local `_` annotations
# are stripped before sending. See KASA-294.
apply_sentry_dashboards() {
  local org="${SENTRY_ORG:-kassa}"

  local manifest="infra/observability/sentry-dashboards.json"
  if [ ! -f "$manifest" ]; then
    # Optional manifest — pre-KASA-294 trees won't have it and that's fine.
    return 0
  fi

  local has_token="false"
  if [ -n "${SENTRY_AUTH_TOKEN:-}" ]; then
    has_token="true"
  fi

  printf '\n== Sentry dashboards (%s) ==\n' "$(verb_for_apply)"

  local cleaned
  cleaned="$(jq 'walk(if type == "object" then with_entries(select(.key | startswith("_") | not)) else . end)' "$manifest")"

  local resolved
  resolved="$(printf '%s' "$cleaned" \
    | sed \
        -e "s|\${SENTRY_ORG}|${SENTRY_ORG:-kassa}|g" \
        -e "s|\${SENTRY_PROJECT_POS}|${SENTRY_PROJECT_POS:-kassa-pos}|g" \
        -e "s|\${SENTRY_PROJECT_API}|${SENTRY_PROJECT_API:-kassa-api}|g" \
        -e "s|\${SENTRY_PROJECT_BACK_OFFICE}|${SENTRY_PROJECT_BACK_OFFICE:-kassa-back-office}|g")"

  # Resolve project slug → numeric id once per run. Sentry's dashboard create
  # endpoint accepts the slug form via `projects: ["<slug>"]` on some org
  # plans but rejects it on others; numeric id is the contract that works
  # across every plan tier. Skip the lookup in no-token mode — the payload
  # preview is still useful to compare against the dashboard UI.
  local projects_index="{}"
  if [ "$has_token" = "true" ]; then
    projects_index="$(curl -fsS \
      -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" \
      "https://sentry.io/api/0/organizations/$org/projects/" \
      | jq '[.[] | { (.slug): .id }] | add // {}')"
  fi

  printf '%s' "$resolved" | jq -c '.dashboards[]' | while read -r dash; do
    local title project_slug project_id payload existing id
    title="$(printf '%s' "$dash" | jq -r '.title')"
    project_slug="$(printf '%s' "$dash" | jq -r '.project_slug // ""')"
    project_id="$(printf '%s' "$projects_index" | jq -r --arg s "$project_slug" '.[$s] // ""')"

    # Drop local routing keys; lift project_slug→numeric-id into projects[]
    # if we resolved one, otherwise keep the slug so no-token preview is
    # still readable.
    if [ -n "$project_id" ]; then
      payload="$(printf '%s' "$dash" | jq --arg id "$project_id" 'del(.project_slug) | . + {projects: [($id | tonumber)]}')"
    else
      payload="$(printf '%s' "$dash" | jq --arg s "$project_slug" 'del(.project_slug) | . + {projects: [$s]}')"
    fi

    if [ "$has_token" = "false" ]; then
      printf '  [would-send] dashboard project=%s title=%s payload=\n' "$project_slug" "$title"
      printf '%s\n' "$payload" | jq .
      continue
    fi

    existing="$(curl -fsS \
      -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" \
      "https://sentry.io/api/0/organizations/$org/dashboards/" \
      | jq --arg t "$title" '[.[] | select(.title == $t)]')"
    id="$(printf '%s' "$existing" | jq -r '.[0].id // ""')"

    if [ -n "$id" ]; then
      printf '  [update] dashboard project=%s title=%s id=%s\n' "$project_slug" "$title" "$id"
      if [ "$APPLY" = "true" ]; then
        curl -fsS \
          -X PUT \
          -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" \
          -H "Content-Type: application/json" \
          -d "$payload" \
          "https://sentry.io/api/0/organizations/$org/dashboards/$id/" >/dev/null
      fi
    else
      printf '  [create] dashboard project=%s title=%s\n' "$project_slug" "$title"
      if [ "$APPLY" = "true" ]; then
        curl -fsS \
          -X POST \
          -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" \
          -H "Content-Type: application/json" \
          -d "$payload" \
          "https://sentry.io/api/0/organizations/$org/dashboards/" >/dev/null
      fi
    fi
  done
}

case "$ONLY" in
  all)
    apply_better_stack
    apply_sentry
    apply_sentry_dashboards
    ;;
  better-stack) apply_better_stack ;;
  sentry)
    apply_sentry
    apply_sentry_dashboards
    ;;
esac

printf '\nDone (%s).\n' "$(verb_for_apply)"
