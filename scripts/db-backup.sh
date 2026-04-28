#!/usr/bin/env bash
# Nightly Postgres backup to S3 for Kassa production — KASA-70.
#
# Streams pg_dump of the production Neon branch to S3 as plain SQL, gzip-
# compressed (`--format=plain | gzip -c`). Intended to run from
# .github/workflows/backup-prod.yml on a daily schedule, but also runnable
# locally for ad-hoc snapshots and disaster-recovery rehearsals.
#
# Restore path is `aws s3 cp s3://<bucket>/<key> - | gunzip -c | psql ...`
# (psql, not pg_restore — pg_restore rejects --format=plain dumps). See
# .github/workflows/backup-prod.yml header for the full DR command.
#
# Streaming (pg_dump | gzip | aws s3 cp -) is deliberate: we never write the
# dump to the runner's disk, so a 5 GB merchant DB does not require a runner
# with 5 GB free, and a runner compromise cannot exfiltrate a dump file that
# never existed on disk.
#
# Exit codes:
#   0 — backup uploaded and verified > 0 bytes
#   1 — backup or verification failed (details on stderr)
#   2 — invalid usage / missing dependency
#
# A non-zero exit in CI surfaces as a failing workflow run, which paginates
# DevOps via GitHub notifications. Provider-side alerting (Better Stack, etc.)
# on missed backups is tracked under KASA-71.
#
# Usage:
#   scripts/db-backup.sh \
#     --database-url "postgres://...@<neon-host>/...?sslmode=require" \
#     --bucket kassa-backups \
#     --prefix prod
#
# Flags:
#   --database-url URL  Postgres connection string. Required.
#                       Falls back to $DATABASE_URL if --database-url omitted.
#   --bucket NAME       S3 bucket (no s3:// prefix). Required.
#                       Falls back to $S3_BUCKET if --bucket omitted.
#   --prefix STR        S3 key prefix; final key is <prefix>/<UTC-date>.sql.gz.
#                       Default: "prod".
#   --label STR         Override the <UTC-date> portion of the key. Optional;
#                       primarily for ad-hoc snapshots / DR rehearsals.
#   --region STR        AWS region. Default ap-southeast-1 (Singapore — same
#                       region family as Fly `sin` and Neon prod).
#   --pg-dump-bin PATH  Override pg_dump binary path (e.g. when multiple
#                       major versions are installed). Default: pg_dump.
#   --dry-run           Skip the S3 upload; only verify pg_dump streams a
#                       non-empty payload. Useful for first-run validation
#                       before AWS credentials are wired.

set -euo pipefail

DATABASE_URL_ARG=""
BUCKET=""
PREFIX="prod"
LABEL=""
REGION="ap-southeast-1"
PG_DUMP_BIN="pg_dump"
DRY_RUN="false"

err() { printf '%s\n' "$*" >&2; }

usage() {
  sed -n '/^# Usage:/,/^$/p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --database-url) DATABASE_URL_ARG="$2"; shift 2;;
    --bucket) BUCKET="$2"; shift 2;;
    --prefix) PREFIX="$2"; shift 2;;
    --label) LABEL="$2"; shift 2;;
    --region) REGION="$2"; shift 2;;
    --pg-dump-bin) PG_DUMP_BIN="$2"; shift 2;;
    --dry-run) DRY_RUN="true"; shift 1;;
    -h|--help) usage;;
    *) err "Unknown flag: $1"; usage;;
  esac
done

DB_URL="${DATABASE_URL_ARG:-${DATABASE_URL:-}}"
if [ -z "$DB_URL" ]; then
  err "Missing --database-url (or DATABASE_URL env)."
  exit 2
fi

if [ "$DRY_RUN" != "true" ] && [ -z "$BUCKET" ]; then
  BUCKET="${S3_BUCKET:-}"
  if [ -z "$BUCKET" ]; then
    err "Missing --bucket (or S3_BUCKET env)."
    exit 2
  fi
fi

if ! command -v "$PG_DUMP_BIN" >/dev/null 2>&1; then
  err "pg_dump not found at '$PG_DUMP_BIN'. Install postgresql-client matching your server major version."
  exit 2
fi

if ! command -v gzip >/dev/null 2>&1; then
  err "gzip not found. Install gzip."
  exit 2
fi

if [ "$DRY_RUN" != "true" ] && ! command -v aws >/dev/null 2>&1; then
  err "aws CLI not found. Install awscli v2."
  exit 2
fi

LABEL="${LABEL:-$(date -u +%Y-%m-%d)}"
KEY="${PREFIX}/${LABEL}.sql.gz"
S3_URI="s3://${BUCKET}/${KEY}"

# pg_dump options:
#   --no-owner / --no-privileges: dumps restore cleanly into Neon-managed
#     instances where role/grant bookkeeping is provider-controlled.
#   --format=plain via stdout so we can stream-pipe through gzip → aws s3 cp.
#   --quote-all-identifiers: future-proof against reserved-word column names.
PG_DUMP_FLAGS=(
  "--no-owner"
  "--no-privileges"
  "--quote-all-identifiers"
  "--format=plain"
)

printf 'Starting pg_dump → %s (region=%s)\n' "$S3_URI" "$REGION"

if [ "$DRY_RUN" = "true" ]; then
  # Stream into a byte counter; assert non-empty without writing anywhere.
  bytes=$("$PG_DUMP_BIN" "${PG_DUMP_FLAGS[@]}" "$DB_URL" | gzip -c | wc -c)
  if [ "$bytes" -le 0 ]; then
    err "pg_dump produced 0 bytes — refusing to declare success."
    exit 1
  fi
  printf 'Dry run OK — pg_dump produced %s gzipped bytes (not uploaded).\n' "$bytes"
  exit 0
fi

"$PG_DUMP_BIN" "${PG_DUMP_FLAGS[@]}" "$DB_URL" \
  | gzip -c \
  | aws s3 cp - "$S3_URI" \
      --region "$REGION" \
      --no-progress

# Verify the object exists and is > 0 bytes. `aws s3 cp` only fails on its
# own request errors; a silently-empty pipe (e.g. pg_dump produced no output
# but exited 0 because of an upstream config quirk) would still result in a
# zero-byte object. The post-upload size check turns that into a red CI run.
size=$(aws s3api head-object \
  --bucket "$BUCKET" \
  --key "$KEY" \
  --region "$REGION" \
  --query ContentLength \
  --output text)

if [ -z "$size" ] || [ "$size" -le 0 ]; then
  err "Uploaded object $S3_URI is empty (size=${size:-<missing>})."
  exit 1
fi

printf 'Backup OK — %s (%s bytes)\n' "$S3_URI" "$size"
