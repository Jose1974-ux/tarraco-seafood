#!/usr/bin/env bash
# TARRACO · copia PostgreSQL comprimida en almacenamiento S3 privado.
# Requiere: pg_dump, gzip, awscli, sha256sum, DATABASE_URL y BACKUP_S3_URI.
# El destino S3 debe pertenecer a otra cuenta/proyecto o proveedor independiente.
set -Eeuo pipefail
umask 077
: "${DATABASE_URL:?Falta DATABASE_URL de solo lectura para copias}"
: "${BACKUP_S3_URI:?Falta BACKUP_S3_URI (s3://bucket/prefijo)}"
command -v pg_dump >/dev/null
command -v gzip >/dev/null
command -v aws >/dev/null
command -v sha256sum >/dev/null
today="$(TZ=Europe/Madrid date +%F)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
name="tarraco-db-${today}.sql.gz"
# Consistencia: pg_dump exporta una instantánea coherente de PostgreSQL.
pg_dump --dbname="$DATABASE_URL" --format=plain --no-owner --no-acl |
  gzip -9 > "$work/$name"
gzip -t "$work/$name"
test -s "$work/$name"
sha256sum "$work/$name" | awk '{print $1}' > "$work/$name.sha256"
base="${BACKUP_S3_URI%/}"
aws s3 cp "$work/$name" "$base/$name" --sse AES256 --only-show-errors
aws s3 cp "$work/$name.sha256" "$base/$name.sha256" --sse AES256 --only-show-errors
# Descargar y comparar la copia remota ANTES de tocar la retención.
aws s3 cp "$base/$name" "$work/remote.gz" --only-show-errors
gzip -t "$work/remote.gz"
cmp "$work/$name" "$work/remote.gz"
# Rotación conservadora: solo borrar ficheros .sql.gz que excedan siete.
# Nunca borrar si no se puede listar el destino o la subida no se verificó.
mapfile -t copies < <(aws s3 ls "$base/" | awk '{print $4}' | grep -E '^tarraco-db-[0-9]{4}-[0-9]{2}-[0-9]{2}\\.sql\\.gz
if (( ${#copies[@]} > 7 )); then
  for old in "${copies[@]:0:${#copies[@]}-7}"; do
    aws s3 rm "$base/$old" --only-show-errors
    aws s3 rm "$base/$old.sha256" --only-show-errors
  done
fi
printf 'Copia verificada: %s (%s bytes comprimidos)\\n' "$name" "$(wc -c < "$work/$name")"
 | sort || true)
if (( ${#copies[@]} > 7 )); then
  for old in "${copies[@]:0:${#copies[@]}-7}"; do
    aws s3 rm "$base/$old" --only-show-errors
    aws s3 rm "$base/$old.sha256" --only-show-errors
  done
fi
printf 'Copia verificada: %s (%s bytes comprimidos)\\n' "$name" "$(wc -c < "$work/$name")"
