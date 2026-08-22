<!-- section: Fixed -->

- **A tile stops answering _who is needed_ when nobody has settled it**
  (`kolonie-platform#1401`). Measured on `/atlas/search?earn=bounty-board`,
  2026-08-22: **twenty-five tiles and twenty-five need chips**, every one of them
  reading _who is needed is not known_.

  A fact printed on every row is not one a reader can use to tell two rows apart.
  And here it was not even new: both unknown wordings open by repeating the walk
  status the mark beside them already carries — _walked, but who is needed is not
  known_ next to a tile that has just said _walked, with no route written_.

  **The rule already existed one surface up.** `#1326` decision 3 stopped the
  provider page's header saying it, and `chips.test.ts` has held that shut since.
  This is the same rule reaching the tile; the four wordings `#1141` split apart
  are untouched and are still what the provider page says, where _has anybody
  established this_ is the page's own subject.

  **The separator moved with it.** All three of need, cost and direction can be
  absent — `rowCost` says nothing when the recipes disagree on a price — and the
  dash was written into the line before them, so a row with none of the three
  would have ended in a dash pointing at nothing. The chips are a list that is
  joined now, and the separator appears only when there is something to separate.
  That is the ordinary cost of a hard-coded separator, and it would have shipped
  as a visible defect on exactly the rows this change creates.

  What was already true and stays: the descriptions are on the tiles. Twenty-four
  of the twenty-five rows measured carried one, and all twenty-five read
  differently — the identity copy `#1401` asks for is there, and what was drowning
  it was the chip.
