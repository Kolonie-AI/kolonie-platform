<!-- section: Added -->

- `atlasBand`, `atlasCommonestStop` and `atlasStopStep`, which turn counts into the three things a small sample can say without describing anybody: whether most, about half or few got through, which outcome walks end at, and which step of the recipe above that outcome pins. They are computed from the unfloored counts before suppression takes them, so the floor has arithmetic to take and nothing else. (#792)
- `atlasBandPhrase` and `atlasStopPhrase`, the wording for both, in core because the entry page and the recipe text were writing it twice and could disagree about what a measurement means. (#792)

<!-- section: Changed -->

- `AtlasFigures` carries `band` and `commonestStop`, and a suppressed entry publishes them instead of apologising. The apology printed on nearly every page in the catalogue — the floor takes every count, and every line was a count — so the measured half of a living page was invisible almost everywhere. Raw counts and percentages stay behind the floor exactly as they were. (#792)
