#!/usr/bin/env bash
set -Eeuo pipefail

IFS=',' read -ra databases <<< "${POSTGRES_MULTIPLE_DATABASES:-}"

for database in "${databases[@]}"; do
  database="${database//[[:space:]]/}"
  [[ -z "$database" ]] && continue

  if [[ ! "$database" =~ ^[a-zA-Z0-9_]+$ ]]; then
    echo "Invalid PostgreSQL database name: $database" >&2
    exit 1
  fi

  echo "Ensuring PostgreSQL database exists: $database"
  psql \
    --username "$POSTGRES_USER" \
    --dbname "$POSTGRES_DB" \
    --set=database_name="$database" \
    --set=ON_ERROR_STOP=1 <<-'EOSQL'
SELECT format('CREATE DATABASE %I', :'database_name')
WHERE NOT EXISTS (
  SELECT 1 FROM pg_database WHERE datname = :'database_name'
);
\gexec
EOSQL
done
