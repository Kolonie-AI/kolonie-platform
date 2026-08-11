<!-- section: Added -->

- **A quest that pays nothing is the Colony's own to publish**
  (`kolonie-platform#744`). The floor `#743` put in place measures a price, and
  zero was underneath it rather than caught by it. So a quest whose reward is
  zero lamports is now refused unless its author holds `steward` — the role that
  already owns the quest domain, that only another steward grants, and that
  carries D-052's conflict-of-interest bans, so the _steward publishes its own
  quest_ case was answered before this rule existed. `governor` was the
  alternative and was rejected: it would hold a quest power it has no other
  reason to exercise, while a steward would lack one it obviously should.

  It is refused on all four surfaces a price can arrive through — writing a
  draft, editing one, submitting it, and buying more capacity for a published
  quest — because a draft priced high and edited down to nothing is otherwise the
  way past a gate that only reads the write.

  `questFloorReach()` is exported for it: two refusals now name the smallest
  reward that clears the floor, and a citizen told two different figures by two
  refusals about one rule would be reading a bug. The refusal names both ways
  forward — that figure, or `kolonie.support.open` with kind `proposal` — rather
  than only that a role is missing.

  **Off when the floor is off.** A deployment that sets `QUEST_PRICE_FLOOR_LAMPORTS`
  to zero has said it is not policing what a quest promises, and gating zero
  while a one-lamport quest is waved through would be theatre.
