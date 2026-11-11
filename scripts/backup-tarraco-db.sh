#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
: "${DATABASE_URL:?DATABASE_URL required}"
: "${BACKUP_S3_URI:?BACKUP_S3_URI required}"
: "${R2_ENDPOINT_URL:?R2_ENDPOINT_URL required, e.g. https://ACCOUNT_ID.r2.cloudflarestorage.com}"
export AWS_DEFAULT_REGION=auto
for cmd in pg_dump gzip aws sha256sum cmp; do command -v "$cmd" >/dev/null; done
day="$(TZ=Europe/Madrid date +%F)"
dir="$(mktemp -d)"
trap 'rm -rf "$dir"' EXIT
file="tarraco-db-$day.sql.gz"
base="${BACKUP_S3_URI%/}"
pg_dump --dbname="$DATABASE_URL" --format=plain --no-owner --no-acl | gzip -9 > "$dir/$file"
gzip -t "$dir/$file"
test -s "$dir/$file"
sha256sum "$dir/$file" | cut -d' ' -f1 > "$dir/$file.sha256"
aws --endpoint-url "$R2_ENDPOINT_URL" s3 cp "$dir/$file" "$base/$file" --only-show-errors
aws --endpoint-url "$R2_ENDPOINT_URL" s3 cp "$dir/$file.sha256" "$base/$file.sha256" --only-show-errors
aws --endpoint-url "$R2_ENDPOINT_URL" s3 cp "$base/$file" "$dir/verify.gz" --only-show-errors
gzip -t "$dir/verify.gz"
cmp "$dir/$file" "$dir/verify.gz"
listing="$(aws --endpoint-url "$R2_ENDPOINT_URL" s3 ls "$base/")"
mapfile -t copies < <(printf '%s\n' "$listing" | awk '{print $4}' | grep -E '^tarraco-db-[0-9]{4}-[0-9]{2}-[0-9]{2}\.sql\.gz$' | sort || true)
count="${#copies[@]}"
if (( count > 7 )); then
  for old in "${copies[@]:0:count-7}"; do
    aws --endpoint-url "$R2_ENDPOINT_URL" s3 rm "$base/$old" --only-show-errors
    aws --endpoint-url "$R2_ENDPOINT_URL" s3 rm "$base/$old.sha256" --only-show-errors
  done
fi
printf 'Verified backup: %s, %s compressed bytes\n' "$file" "$(wc -c < "$dir/$file")"
