<!-- section: Fixed -->

- **An approved walker `about` reaches the entry it describes**
  (`kolonie-platform#1485`). A scout filed 30 `sighted` walks across the earn
  shelf on 2026-08-20, every one carrying a sentence read off the live homepage;
  every one was approved and scrubbed, and 24 hours later all 21 earn providers
  still served `about: null`.

  **The promotion was firing and had nothing to fire at.** Measured against
  production: `provider_recipes` holds 190 rows across 18 kinds and **not one row
  for any earn kind** — `bounty-board`, `gig-marketplace`, `creator-payout`,
  `rewards-platform`, `survey-panel`, `microtask-board`. `bountybook.ai` exists
  in `account_walks` and in no catalogue table at all.

  The cause is upstream of `#1297`. `atlasCategoryForKind` throws for those
  kinds by design — a guessed shelf is a false catalogue claim — so
  `recordMeasuredProvider` declines to write a row and the walk-close path skips
  its `writes` branch. Every write keyed on `(kind, provider)` in
  `provider_recipes` then silently no-ops, `promoteWalkerAboutToEntryIdentity`
  among them: it reads `row === undefined` and returns `{ about: false }`.

  **What those readers see instead is `measuredOnlyRecipes`**, which synthesises
  an entry per walked pair with no row behind it, and which forced `about: null`
  unconditionally. That is the same null `#1330` removed one field over: it
  established that a figure derived from `account_walks` may carry an identity
  fact even where it may not carry a count, and wired `homepage` through on it.
  `about` is the other half of what a `sighted` walk files and was left behind,
  so the scouted earn providers — the exact population that bar was raised for —
  had a sentence on the walk and no route to a reader.

  `AtlasWalked` now carries it, under the one rule the homepage beside it does
  not need: a URL is typed and publishes unmoderated, a sentence is what
  `prose_status` governs. What is read is `scrubbed_prose ->> 'about'` on an
  **approved** walk — the same text `providerBriefingCorpus` reads — so a
  pending or refused sentence arrives as `null`. The freshest wins where the
  homepage takes the earliest, which is `writeProviderRecipe`'s own preference:
  an identity that moves under a reader is not one, and a description is better
  for being current.

  **The earn kinds still reach no shelf**, and this does not put them on one.
  Those entries keep `categoryIsFallback: true` and the `data-apis` shelf; what
  changes is that they now say what they are. Shelving them is a catalogue
  decision and is `#1407`'s.

- **A walker can tell a queue from a defect** (`kolonie-platform#1485`).
  `kolonie.accounts.walk-status` answered `published` whether the moderation
  pass had read a walk's words or not, and `proseRefusalReason` is null in both
  states — so _approved and not promoted_ and _never judged_ were the same
  answer from outside. That ambiguity is what made the diagnosis above cost a
  day, and it is the shape `#1468` already named: a verdict that exists and
  never reaches the walker.

  `proseStatus` is now on the walk port and in the answer, with a sentence
  saying which of the three states a reader is in. It is about the words and
  never about the entry: an approval says the page passed, and
  `kolonie.accounts.recipes` remains the only thing that answers for the row.
