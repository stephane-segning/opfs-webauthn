#!/bin/sh
# Render runtime config (apps/web/docker/config.js.template) into
# the document root so the page can read it before any bundle
# script runs.
#
# The nginx-unprivileged base image runs every executable in
# `/docker-entrypoint.d/` in alphabetical order before exec'ing
# `nginx -g 'daemon off;'`, so this script lands ahead of the
# server start. Order prefix `40-` keeps it between the base
# image's `20-envsubst-on-templates.sh` and `30-tune-worker-processes.sh`
# — no collision with anything nginx itself ships.
#
# Defaults below mean "missing env var = sharing disabled". The
# entrypoint exits non-zero only if envsubst itself fails (gettext
# missing) — we let nginx crash-loop noisily in that case rather
# than serving a half-rendered config.

set -eu

# Envsubst only substitutes variables present in the env; the
# `${VAR:-}` form is shell-only, so we set the var explicitly so
# the empty-string default lands in the output.
SHARE_BACKEND_URL="${SHARE_BACKEND_URL:-}"
export SHARE_BACKEND_URL

TEMPLATE=/etc/opfs/config.js.template
OUTPUT=/usr/share/nginx/html/config.js

if [ ! -f "$TEMPLATE" ]; then
  echo "render-config: template missing at $TEMPLATE" >&2
  exit 1
fi

# Allow-list the var(s) we substitute so the template can contain
# literal `$foo` strings safely.
envsubst '${SHARE_BACKEND_URL}' < "$TEMPLATE" > "$OUTPUT"

echo "render-config: SHARE_BACKEND_URL=${SHARE_BACKEND_URL:-(empty, sharing disabled)}"
