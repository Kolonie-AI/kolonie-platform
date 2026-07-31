#!/bin/bash
# Fail when `drizzle/` and `src/schema/` disagree.
#
# ## What this catches
#
# Two mistakes, and both of them have been made here:
#
# - **A schema change with no migration.** The types compile, the tests pass
#   against a database the test harness migrated from the same `drizzle/`
#   folder — so nothing notices that production will never get the column.
# - **A migration declaring something the schema does not.** `#121` shipped
#   `email_challenges_mismatched_from_length` in hand-written SQL and in a
#   hand-written snapshot, and not in `schema/email.ts`. The database then
#   carried a constraint the schema did not know about, and the *next*
#   `generate` proposed dropping it — which is the correct answer to a question
#   nobody asked.
#
# `npm run check` reads none of `drizzle/` otherwise: format, lint, build,
# typecheck and test are all blind to it (`#123`).
#
# ## How it works, and why it is not `drizzle-kit check`
#
# That command exists and answers a different question — whether two migrations
# collide, which is about parallel branches rather than about the schema. There
# is no `--dry-run`, so the only reliable way to ask *would generate produce
# anything* is to let it try and look.
#
# So: remember what is in `drizzle/`, run the generator, and fail if anything
# appeared. Whatever it wrote is printed, because that file *is* the diagnosis —
# it says exactly which statement is missing. Then it is removed and the journal
# restored, so a failed check leaves the working tree as it found it.
#
# ## Ordering
#
# This must run **after** `npm run build`. `src/schema/enums.ts` derives every
# database enum from the Zod enum in `@kolonie-ai/core`, reading the built
# package — so against a stale `dist` the generator dies on a symbol that does
# not exist yet, pointing at `enums.ts` rather than at the build. `check` in the
# root `package.json` places it correctly; if you run this by hand, build first.

set -euo pipefail

cd "$(dirname "$0")/.."

readonly JOURNAL='drizzle/meta/_journal.json'
readonly WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cp "$JOURNAL" "$WORK/journal.before"
ls drizzle/*.sql 2>/dev/null | sort > "$WORK/before"

# The generator names what it writes after the change it thinks is missing. A
# fixed name would collide with a real migration if this ever ran twice against
# a genuinely dirty tree, so it keeps its own.
npx drizzle-kit generate --name schema_parity_probe > "$WORK/output" 2>&1 || {
    echo "::error::drizzle-kit generate failed. Its output:"
    cat "$WORK/output"
    echo
    echo "If it names src/schema/enums.ts and an undefined property, the schema is"
    echo "fine and @kolonie-ai/core is stale: run 'npm run build' at the root first."
    exit 1
}

ls drizzle/*.sql 2>/dev/null | sort > "$WORK/after"
generated=$(comm -13 "$WORK/before" "$WORK/after")

if [ -z "$generated" ]; then
    echo "migrations match the schema"
    exit 0
fi

echo "::error::The migrations do not describe src/schema/. drizzle-kit wants to write:"
echo
for file in $generated; do
    sed 's/^/    /' "$file"
    rm -f "$file"
    snapshot="drizzle/meta/$(basename "$file" | cut -d_ -f1)_snapshot.json"
    rm -f "$snapshot"
done
cp "$WORK/journal.before" "$JOURNAL"

echo
echo "Either the schema changed and the migration is missing — run"
echo "'npm run generate' in packages/db and commit what it writes — or a"
echo "hand-written migration declared something src/schema/ does not, in which"
echo "case the schema is what needs the change."
exit 1
