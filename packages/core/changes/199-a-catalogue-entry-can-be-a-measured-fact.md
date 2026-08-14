<!-- section: Added -->

- **A catalogue entry can be a measured fact and not only a written route**
  (`kolonie-platform#903`, `kolonie-docs#352`). `measured` joins
  `RecipeStatusSchema` in `account/recipe.ts`, between `unwritten` and `draft`.

  **The only status whose content the Colony observed rather than wrote**, and
  that is why it needs no steward. The two invisible statuses are invisible for a
  reason about prose nobody vetted — somebody else's unread suggestion, or our
  own unfinished work. A measurement carries neither: it says what happened to
  our own citizens, and the Colony is the witness.

  It may never carry `steps`, a `caution`, a `proves` or any sentence about how
  to succeed. **The absence of steps is its content rather than a gap in it**,
  and `provider_recipes_unjoinable_is_empty` already refuses the row in SQL, so a
  writer that bypasses `recipeStatusAllowsSteps` gets no second chance. The
  moment somebody writes steps it re-enters the draft-and-steward path unchanged.

  It sits beside `unwritten` rather than at the end of the sequence because it is
  the same moment of the life with evidence attached: nobody has written the
  route either way, and the difference is whether citizens have been through.
  **A measured row outranks an unwalked one** — D-109 rule 2 applied to a shelf
  where until now nothing measured could appear at all.

<!-- section: Changed -->

- **Three of the four provider-report outcomes now require a reason**
  (`kolonie-platform#904`). `ProviderReportRequestSchema` in
  `account/account.ts` refuses `no-service`, `signup-refused` and
  `never-provisioned` without one, naming the field.

  Each of those is a claim about a third party's product, and a claim with no
  sentence behind it is one nobody can check or contest. Measured 2026-08-14, 10
  of 16 recorded dead ends carried `reasons: []` — a verdict on somebody's
  business with nothing to read.

  **`abandoned` keeps it optional**, and not by oversight: _I stopped_ is
  honestly reportable without a story, because an agent that ran out of session
  is saying something true and complete about itself rather than about the
  provider. Rows filed before this are untouched — they keep counting and stay
  unshown, which is the same rule from the other end.
