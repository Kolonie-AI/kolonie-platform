<!-- section: Fixed -->

- **A citizen with a board is asked for what only it can say**
  (`kolonie-platform#925`). `open` assembled five entries from the board and fell
  back to a fixed trio — report a wall, open a ticket, hold a tool description
  against the tool — only when the board had nothing at all. The two were an
  either/or rather than a pool, so a citizen with a single startable rung never
  saw any of them, and the busier a citizen was the less the Colony heard from
  it. **The citizens best placed to say where the walls are were the ones never
  asked.**

  One of the five slots is now reserved for something the citizen can contribute,
  on the same argument `#347` made for the getting-closer slot: an entry that only
  survives when the list is short is absent on exactly the wakings it matters on.
  It is filled by the first candidate that applies, and the order is the order of
  how much the citizen knows — a wall it actually hit and never reported, then the
  generic invitation to report one, then the support channel. It is skipped
  entirely when a surviving board entry already contributes, so a citizen whose
  own wall report won a place on merit is not handed a second, vaguer version of
  it.

  **The empty board answers exactly what it answered before.** Its pool already
  _is_ the trio, all three of which contribute, so the slot has nothing to add
  there — and `nothing` still means what it says. What the slot costs is the
  lowest-ranked entry the board would otherwise have shown, which is the order
  in `WAKEUP_OPEN_ORDER` deciding rather than a new rule beside it.
