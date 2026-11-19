#!/usr/bin/env bash
# Personal preview: run SuperDes alone on this Mac (single owner, localhost only).
# Uses database superdes_preview; backend http://127.0.0.1:8020, frontend http://127.0.0.1:5180.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")" && pwd)
PG=/Applications/Postgres.app/Contents/Versions/latest/bin
DB=superdes_preview
API_PORT=8020
WEB_PORT=5180

for port in $API_PORT $WEB_PORT; do
  if lsof -nP -iTCP:$port -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $port is already in use. Stop whatever runs there (or a previous preview.sh) and try again." >&2
    exit 1
  fi
done
[[ -x $PG/psql ]] || { echo "Postgres.app not found at $PG" >&2; exit 1; }
"$PG/pg_isready" -q || { echo "Postgres is not running. Start Postgres.app first." >&2; exit 1; }

if [[ $("$PG/psql" -d postgres -tAc "select 1 from pg_database where datname = '$DB'") != 1 ]]; then
  echo "Creating database $DB"
  "$PG/createdb" "$DB"
fi

# Ollama and other optional settings; everything below overrides it.
if [[ -f $ROOT/backend/.env ]]; then set -a; source "$ROOT/backend/.env"; set +a; fi

SECRET_FILE=$ROOT/backend/.preview-secret
if [[ ! -s $SECRET_FILE ]]; then
  (umask 077; openssl rand -hex 32 > "$SECRET_FILE")
fi
chmod 600 "$SECRET_FILE"

cd "$ROOT/backend"
DATABASE_ADMIN_URL="postgresql:///$DB" APP_USER_PASSWORD=app_user_dev .venv/bin/python scripts/migrate.py

export PREVIEW_MODE=1 COOKIE_SECURE=0 ENV=dev
export JWT_SECRET=$(cat "$SECRET_FILE")
export DATABASE_URL="postgresql://app_user:app_user_dev@localhost:5432/$DB"
export FRONTEND_ORIGIN=http://localhost:5180 API_URL=http://localhost:8020

pids=()
stop() { trap - INT TERM EXIT; kill ${pids[@]+"${pids[@]}"} 2>/dev/null || true; wait 2>/dev/null || true; echo; echo "Preview stopped."; }
trap stop INT TERM EXIT

.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port $API_PORT & pids+=($!)
(cd "$ROOT/frontend" && HOST=127.0.0.1 PORT=$WEB_PORT exec .venv/bin/python server.py) & pids+=($!)

echo "SuperDes personal preview: http://localhost:$WEB_PORT  (Ctrl+C stops it)"
wait
