#!/bin/bash
# Put a PostgreSQL 16 suitable for the integration tests in front of you, fast.
#
# **This is *a* way and not *the* way** (`#283`). `operations/testing.md` in
# kolonie-docs fixes the interface at one variable — a test reads `DATABASE_URL`
# and may know nothing else — precisely so that this file is a convenience rather
# than a requirement. A contributor with the Compose stack from `kolonie-infra`,
# an `apt`-installed server, or a hosted throwaway database needs nothing here:
# point `DATABASE_URL` at it and run `npm run test:db:relax` instead.
#
# It exists because the alternative was worse. Until `#283` the only start
# command in the tree was inside an error message in `src/testing.ts`, and it
# started a server at full crash-durability — so every agent that set this up
# copied the slow one and paid roughly double for a guarantee this database
# cannot use. See `relax-test-durability.mjs` for what is traded and why it is
# safe here and nowhere else.

set -euo pipefail

readonly NAME="${KOLONIE_TEST_DB_NAME:-kolonie-pg}"
readonly PORT="${KOLONIE_TEST_DB_PORT:-5433}"
readonly URL="postgres://postgres:postgres@127.0.0.1:${PORT}/kolonie_test"

# Port 5432 is left alone on purpose: the Compose stack in kolonie-infra wants it,
# and a test database that squats on it turns "run the stack" into a puzzle.

# Not everyone is in the `docker` group, and on the machines this was written for
# some are and some are not. Detected rather than assumed, because the failure is
# a permission error on a socket, which reads like Docker not running.
if docker info >/dev/null 2>&1; then
    DOCKER=(docker)
elif sudo -n docker info >/dev/null 2>&1; then
    DOCKER=(sudo -n docker)
else
    echo "Cannot talk to a container runtime, with or without sudo." >&2
    echo >&2
    echo "This script is only one way to get a PostgreSQL 16. Any other will do:" >&2
    echo "  export DATABASE_URL=postgres://…/kolonie_test" >&2
    echo "  npm run test:db:relax" >&2
    exit 1
fi

if "${DOCKER[@]}" start "$NAME" >/dev/null 2>&1; then
    echo "started existing container $NAME"
else
    "${DOCKER[@]}" run -d --name "$NAME" \
        -e POSTGRES_PASSWORD=postgres \
        -e POSTGRES_DB=kolonie_test \
        -p "127.0.0.1:${PORT}:5432" \
        postgres:16 >/dev/null
    echo "created container $NAME"
fi
# No --restart flag: this holds test rows and nothing else, so it costs a second
# to recreate and should not outlive a reboot silently.

# `docker run` returns when the container starts, not when Postgres accepts
# connections, and the first thing we do is connect. Waiting on the real question
# rather than on a fixed sleep, which is either too short on a cold machine or
# wasted on a warm one.
printf 'waiting for postgres'
for _ in $(seq 1 60); do
    if "${DOCKER[@]}" exec "$NAME" pg_isready -U postgres >/dev/null 2>&1; then
        echo
        DATABASE_URL="$URL" node "$(dirname "$0")/relax-test-durability.mjs"
        echo
        echo "export DATABASE_URL=$URL"
        exit 0
    fi
    printf '.'
    sleep 1
done

echo >&2
echo "Postgres in $NAME did not accept connections within 60s. Its log:" >&2
"${DOCKER[@]}" logs --tail 20 "$NAME" >&2
exit 1
