#!/bin/sh
# Container entrypoint: apply migrations, start the every-minute cron trigger, run the Worker.
set -eu

DATA="${PINGWARD_DATA:-/data}"
PORT="${PORT:-8787}"

if [ -z "${API_TOKEN:-}" ]; then
  echo "PingWard: API_TOKEN is not set, so the dashboard is read-only (every write is refused)." >&2
  echo "          Start the container with -e API_TOKEN=<16+ chars of letters, digits, - _ . ~ + />." >&2
fi

# Tables live in $DATA (mount a volume there to keep them). Already-applied migrations are skipped.
npx wrangler d1 migrations apply DB --local --persist-to "$DATA"

# Wrangler doesn't fire Cron Triggers locally, so call the scheduled handler once a minute.
WORKER_URL="http://127.0.0.1:${PORT}" node worker/scripts/local-cron.mjs &

# Secrets are passed as Worker variables only when set.
set --
if [ -n "${API_TOKEN:-}" ]; then set -- "$@" --var "API_TOKEN:${API_TOKEN}"; fi
if [ -n "${TELEGRAM_BOT_TOKEN:-}" ]; then set -- "$@" --var "TELEGRAM_BOT_TOKEN:${TELEGRAM_BOT_TOKEN}"; fi
if [ -n "${READ_PROTECTED:-}" ]; then set -- "$@" --var "READ_PROTECTED:${READ_PROTECTED}"; fi

exec npx wrangler dev \
  --ip 0.0.0.0 --port "$PORT" \
  --persist-to "$DATA" \
  --test-scheduled \
  --show-interactive-dev-session=false \
  "$@"
