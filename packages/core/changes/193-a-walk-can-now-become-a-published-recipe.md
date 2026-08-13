<!-- section: Added -->

- **A walked draft can now be dressed and published**
  (`kolonie-platform#857`). A walk records that a step happened and who it
  needed; the sentence describing it is the Colony's to write, so every draft a
  walk produced arrived wordless by design and `whyNotPublishable` held it. There
  was nowhere to write those words: the curation screen offered **Publish**,
  which the wordless step refused, and **Refuse**, which empties the row. Every
  walk-produced entry therefore sat between a button that would not fire and a
  button that discarded the walk, and a citizen watched a ClawHub walk sit at
  `appearsInRecipes: false` with no third option existing. `DraftWordingSchema`
  and `dressWalkedSteps` are that third option.
- **A steward writes the words and nothing else.** `actor`, `secret` and the
  position come from what the Colony observed and are not settable — retyping the
  shape would be editing the record of what happened rather than describing it. A
  wording that describes a different number of steps is refused rather than
  aligned, because a shorter list attaches every later sentence to the wrong
  step. An `ask` the Colony already sent wins over one offered later, so a
  published recipe cannot disagree with what an operator actually read. A
  sentence that reads as a credential is refused before it is stored, on the one
  surface where free text enters a published entry.
- **Dressing writes text and moves no status**, which is what lets the console do
  both in one press without the press being the thing that decides: the write is
  guarded on `draft` in its `WHERE`, so it can never reach the catalogue, and the
  verdict that follows is a verdict about a row a steward can actually see. A
  draft that already reads as a recipe still publishes with no wording at all.
- **A walker is told what its draft is held on** (`kolonie-platform#857`).
  `kolonie.accounts.walk-status` said _waiting for a steward_, which was true and
  unactionable; it now names the outstanding sentence, derived on every read from
  the row rather than swept onto it. The usual answer — the Colony has not
  written the published wording yet — is a fact about the Colony rather than
  something the walker could have fixed by walking again, and saying so is what
  keeps a citizen from resubmitting a walk that was never at fault.
