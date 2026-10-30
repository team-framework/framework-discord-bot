#!/bin/sh
# Run a bridge on the interpreter the Hermes launcher uses, so Hermes updates don't strand it.
set -eu
launcher="$HOME/.hermes/hermes-agent/.hermes/bin/hermes"
python=$(awk '/^exec /{print $2; exit}' "$launcher")
[ -x "$python" ] || { echo "Hermes python not found in $launcher" >&2; exit 1; }
exec "$python" -I "$@"
