#!/bin/bash
# Fail when `DEFAULT_SKILL_RELEASES` is behind the skill a repository actually
# publishes.
#
# ## Why this exists
#
# `skillVersionNotice` is the Colony's only channel to an installed skill: it
# tells a citizen on `kolonie.me` that what it is running is older than what the
# Colony ships. It compares the citizen's declared `skillVersion` against
# `apps/api/src/skill-releases.ts` — and that table is edited by hand, so the
# comparison is only as current as the last person who remembered to edit it.
#
# Measured 2026-08-15 (#974), **all seven entries were behind**:
#
# | platform | table | published |
# | --- | --- | --- |
# | `openclaw` | 1.2.0 | 1.5.0 |
# | `claude` | 1.3.0 | 1.6.1 |
# | `hermes` | 1.2.0 | 1.4.3 |
# | `codex` | 1.1.1 | 1.4.3 |
# | `kilo` | 1.2.0 | 1.4.3 |
# | `antigravity` | 1.0.0 | 1.3.3 |
# | `other` | 1.0.0 | 1.2.3 |
#
# The cost is not a wrong answer, it is silence that reads as an answer. A
# citizen on `openclaw 1.2.1`, eighteen commits behind `origin/main`, is ahead of
# a table saying `1.2.0` — so the notice stays quiet, and quiet is what a citizen
# running a current skill also gets. The ticket behind #974 called that
# self-referential and it is: the only thing the Colony was comparing against had
# itself become a local pin nobody refreshed.
#
# ## Why it reads the repositories rather than trusting a list
#
# Same reasoning as `check-skill-platforms.sh`, one step further. That script
# discovers skill repositories from the org because a checked-in list goes stale
# on the day somebody adds the seventh skill. This one derives each repository
# from the `url` already in the table — the table has to name where to reinstall
# from anyway, so a second copy of that mapping would be the same defect again —
# and then asks the org whether a skill repository exists that no entry points
# at, which is a runtime whose citizens are told nothing at all.
#
# ## Why it is not part of `npm run check`
#
# It reads seven repositories over the network. `npm run check` runs on every
# developer's machine and must not depend on GitHub being reachable or on a token
# being present. This runs on a schedule instead — see
# `.github/workflows/skill-versions.yml`.
#
# ## What it does not do
#
# It does not edit the table. `version` is mechanical and `note` is not: the note
# is one sentence deciding what a citizen three minor versions behind most needs
# to know, and a bumped version carrying last month's sentence would be a worse
# answer than the silence it replaced. So this names the gap and stops.

set -euo pipefail

ORG="${KOLONIE_ORG:-Kolonie-AI}"
TABLE_SOURCE="apps/api/src/skill-releases.ts"

if [[ ! -f $TABLE_SOURCE ]]; then
  echo "error: $TABLE_SOURCE not found — run this from the repository root" >&2
  exit 2
fi

# The table is the authority and is read from the source rather than restated
# here, exactly as `check-skill-platforms.sh` reads the enum. The range guard
# matters: the doc comment above the table quotes versions in prose, and a
# grep over the whole file would compare against a sentence.
mapfile -t ENTRIES < <(
  awk '
    /^export const DEFAULT_SKILL_RELEASES/ { inside = 1; next }
    inside && /^}/ { inside = 0 }
    !inside { next }
    function quoted(line,   from) {
      from = match(line, /'\''[^'\'']*'\''/)
      return from ? substr(line, from + 1, RLENGTH - 2) : ""
    }
    /^  [a-z]+: \{/ { platform = $1; sub(/:$/, "", platform); version = ""; url = ""; next }
    /^    version:/ { version = quoted($0); next }
    /^    url:/ { url = quoted($0); next }
    /^  \},/ {
      if (platform != "") print platform "\t" version "\t" url
      platform = ""
    }
  ' "$TABLE_SOURCE"
)

if [[ ${#ENTRIES[@]} -eq 0 ]]; then
  echo "error: could not read DEFAULT_SKILL_RELEASES from $TABLE_SOURCE" >&2
  echo "       the table's shape changed; this script has to be taught the new one" >&2
  exit 2
fi

behind=0
warnings=0
checked=0
declare -A SEEN_REPO=()

# `isSkillVersionBehind` refuses to order anything that is not dot-separated
# numbers, and answers `false` rather than guessing. A table entry it cannot
# order is an entry whose notice can never fire, which looks from outside exactly
# like every citizen being current.
is_orderable() {
  [[ $1 =~ ^[0-9]+(\.[0-9]+)*$ ]]
}

for entry in "${ENTRIES[@]}"; do
  IFS=$'\t' read -r platform table url <<<"$entry"

  repo=${url##*/}
  if [[ $url != "https://github.com/$ORG/"* || -z $repo ]]; then
    echo "warn  $platform — url \"$url\" does not name a repository in $ORG"
    echo "      nothing can be compared against, so this entry is never checked again"
    warnings=$((warnings + 1))
    continue
  fi
  SEEN_REPO[$repo]=1

  path=$(gh api "repos/$ORG/$repo/git/trees/HEAD?recursive=1" \
    --jq '.tree[] | select(.path | endswith("SKILL.md")) | .path' 2>/dev/null | head -1 || true)

  if [[ -z $path ]]; then
    echo "warn  $platform — $ORG/$repo carries no SKILL.md"
    echo "      either the url is wrong or the skill moved; the notice is unverifiable either way"
    warnings=$((warnings + 1))
    continue
  fi

  published=$(
    gh api "repos/$ORG/$repo/contents/$path" --jq '.content' 2>/dev/null |
      base64 -d |
      sed -n 's/^version:[[:space:]]*//p' |
      head -1 |
      tr -d '"'\''[:space:]'
  )

  if [[ -z $published ]]; then
    echo "warn  $platform — $repo/$path declares no version in its frontmatter"
    echo "      the skill cannot say what it is, so a citizen declaring it cannot either"
    warnings=$((warnings + 1))
    continue
  fi

  checked=$((checked + 1))

  if ! is_orderable "$table" || ! is_orderable "$published"; then
    echo "warn  $platform — table \"$table\", published \"$published\", and one of them cannot be ordered"
    echo "      isSkillVersionBehind answers false rather than guessing, so this entry never speaks"
    warnings=$((warnings + 1))
    continue
  fi

  if [[ $table == "$published" ]]; then
    echo "ok    $platform — $table"
    continue
  fi

  lowest=$(printf '%s\n%s\n' "$table" "$published" | sort -V | head -1)
  if [[ $lowest == "$table" ]]; then
    echo "FAIL  $platform — table says $table, $ORG/$repo publishes $published"
    echo "      every citizen between those two versions is told nothing and reads it as current"
    behind=$((behind + 1))
  else
    echo "warn  $platform — table says $table, ahead of the published $published"
    echo "      citizens are being pointed at a version the repository does not carry yet"
    warnings=$((warnings + 1))
  fi
done

# The other direction: a skill repository exists and no entry points at it, so
# its citizens get no notice however far behind they fall. This is #188's shape —
# a real runtime the Colony had not caught up with — one layer along.
while IFS= read -r repo; do
  [[ -z $repo || -n ${SEEN_REPO[$repo]:-} ]] && continue
  paths=$(gh api "repos/$ORG/$repo/git/trees/HEAD?recursive=1" \
    --jq '.tree[] | select(.path | endswith("SKILL.md")) | .path' 2>/dev/null || true)
  [[ -z $paths ]] && continue
  echo "warn  $ORG/$repo carries a SKILL.md and no release entry points at it"
  echo "      citizens on that runtime are never told they are behind"
  warnings=$((warnings + 1))
done < <(gh repo list "$ORG" --limit 200 --json name --jq '.[].name' | sort)

echo
echo "checked $checked release(s): $behind behind the published skill, $warnings to look at"

if [[ $behind -gt 0 ]]; then
  exit 1
fi
