#!/bin/bash
# Fail when a skill repository instructs a `platform` value the Colony refuses.
#
# ## Why this exists
#
# It has happened twice, on consecutive days, and both times a human found it by
# reading a file rather than anything finding it automatically:
#
# - **2026-07-31, `kilo`** (#125). Named as an entry point in `ARCHITECTURE.md`
#   since the repository layout was written, missing from `AgentPlatformSchema`
#   the whole time. Nothing surfaced it until `kolonie-kilo` was built and its
#   skill instructed a value the Colony refuses.
# - **2026-08-01, `antigravity`** (#186, #188). `kolonie-antigravity` shipped that
#   morning instructing `platform: "other"`, in a paragraph that said in as many
#   words that it was asking the agent to write something that looks wrong. It
#   stayed that way for a day.
#
# The cost is not a failed call. `platform` is how the Colony tells a broken task
# apart from a broken runtime, it is refused rather than applied when a citizen
# asks to change it, and a population registered under the wrong value is a
# diagnostic that cannot answer the question it exists for.
#
# ## Why it discovers the repositories instead of listing them
#
# A checked-in list of skill repositories is a second copy of the org, and it goes
# stale exactly when it matters: the day somebody adds the seventh skill. So the
# org is asked. Any repository holding a `SKILL.md` is a skill repository, which
# is also the rule `kolonie-docs` uses, and a new one is covered on the day it is
# created without anybody remembering to add it here.
#
# ## Why it is not part of `npm run check`
#
# It reads six repositories over the network. `npm run check` runs on every
# developer's machine and must not depend on GitHub being reachable or on a token
# being present. This runs on a schedule instead — see
# `.github/workflows/skill-platforms.yml`.
#
# ## What it does not do
#
# It does not edit anything. A refused value is a decision — either the skill is
# wrong or the enum is missing a runtime, and #188 was the second of those. The
# check says which value and which repository; a human or an agent decides.

set -euo pipefail

ORG="${KOLONIE_ORG:-Kolonie-AI}"
ENUM_SOURCE="packages/core/src/agent/agent.ts"

if [[ ! -f $ENUM_SOURCE ]]; then
  echo "error: $ENUM_SOURCE not found — run this from the repository root" >&2
  exit 2
fi

# The enum is the authority, and it is read from the source rather than restated
# here. A copy in this file would be the same defect one layer down.
mapfile -t ALLOWED < <(
  sed -n '/export const AgentPlatformSchema = z.enum(\[/,/^])/p' "$ENUM_SOURCE" |
    grep -oE "^\s*'[a-z-]+'," |
    tr -d " ',"
)

if [[ ${#ALLOWED[@]} -eq 0 ]]; then
  echo "error: could not read AgentPlatformSchema from $ENUM_SOURCE" >&2
  echo "       the enum's shape changed; this script has to be taught the new one" >&2
  exit 2
fi

echo "AgentPlatformSchema accepts: ${ALLOWED[*]}"
echo

is_allowed() {
  local value=$1
  for allowed in "${ALLOWED[@]}"; do
    [[ $value == "$allowed" ]] && return 0
  done
  return 1
}

# Every repository in the org that carries a SKILL.md at any depth.
mapfile -t REPOS < <(gh repo list "$ORG" --limit 200 --json name --jq '.[].name' | sort)

failures=0
warnings=0
checked=0

for repo in "${REPOS[@]}"; do
  # One search per repository rather than a tree walk: cheap, and it finds the
  # file whether it sits at the root or under `skills/kolonie/`.
  paths=$(gh api "repos/$ORG/$repo/git/trees/HEAD?recursive=1" \
    --jq '.tree[] | select(.path | endswith("SKILL.md")) | .path' 2>/dev/null || true)
  [[ -z $paths ]] && continue

  while IFS= read -r path; do
    [[ -z $path ]] && continue
    checked=$((checked + 1))
    body=$(gh api "repos/$ORG/$repo/contents/$path" --jq '.content' 2>/dev/null | base64 -d || true)

    # Both forms a skill can instruct the value in: the prose sentence the six
    # entry-point skills use, and a literal in a configuration or payload block.
    mapfile -t found < <(
      printf '%s' "$body" |
        grep -oE '`platform` is `"[a-z-]+"`|"?platform"?[[:space:]]*:[[:space:]]*"[a-z-]+"' |
        grep -oE '"[a-z-]+"' |
        tr -d '"' |
        sort -u
    )

    if [[ ${#found[@]} -eq 0 ]]; then
      echo "warn  $repo/$path — instructs no platform value"
      echo "      an arriving agent is left to guess the field the Colony validates"
      warnings=$((warnings + 1))
      continue
    fi

    for value in "${found[@]}"; do
      if ! is_allowed "$value"; then
        echo "FAIL  $repo/$path — instructs platform \"$value\", which the Colony refuses"
        echo "      either the skill is wrong, or AgentPlatformSchema is missing a runtime."
        echo "      #125 was the second of those, and #188 was too."
        failures=$((failures + 1))
      elif [[ $value == other ]]; then
        echo "warn  $repo/$path — instructs platform \"other\""
        echo "      \"other\" is accepted, so this is not a failure. It is how #188 looked"
        echo "      the day before it was filed: a real runtime with no value of its own."
        warnings=$((warnings + 1))
      else
        echo "ok    $repo/$path — platform \"$value\""
      fi
    done
  done <<<"$paths"
done

echo
echo "checked $checked skill file(s): $failures refused, $warnings to look at"

if [[ $failures -gt 0 ]]; then
  exit 1
fi
