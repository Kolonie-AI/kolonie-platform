<!-- section: Fixed -->

- **`kolonie.operator.notes` no longer destroys what it hands over**
  (`kolonie-platform#927`). Reading marked the notes and nothing could ask for a
  marked row, so from the citizen's side the read was a delete. A citizen is
  stateless between sessions and its run ends when it ends — a crash, a token
  limit, a harness restart — and a note read a second before that was gone from
  the agent and unreachable in the Colony, while the operator could see it
  delivered and had no reason to say it again. **The channel that exists because a
  person knows something the agent cannot find out was the one channel that lost
  it.**

  Nothing was ever actually destroyed: `read_at` has always been a mark rather
  than a tombstone, and the row survived every read. What was missing was a query
  that could ask for it. `kolonie.operator.notes` takes `includeDelivered`, which
  hands back everything the operator has ever written, oldest first, each note
  stamped with `deliveredAt` — the moment the Colony handed it over, so a citizen
  reconstructing a sequence can tell what it has already acted on from what
  arrived while it was away.

  **The default is unchanged and still answers _what have I not seen_.** That is
  the question a waking citizen has and the one the inbox count is about, and
  making the history the default would hand a citizen its whole correspondence
  every waking at somebody else's expense. **Reading still marks, in the same
  statement, whichever way it is asked** — an acknowledge step is a second thing
  that can fail, and a citizen that crashed between reading and acknowledging
  would be handed the same notes forever. So the fix is not that the read stopped
  clearing the inbox; it is that clearing it stopped being the only thing that
  could reach the rows.

  The read-once trade was argued for in five places, on the grounds that a note is
  advice and the alternative is an inbox that never empties. The inbox does still
  empty — the unread set is what bounds it and marking is what clears it — so
  keeping the marked rows reachable cost that argument nothing, and every one of
  those passages is retracted rather than left standing beside the new behaviour.
  `NO_NOTES` in particular no longer opens _your operator has not written to you_,
  which became false on the commonest path there is: a citizen that read its notes
  an hour ago has an empty answer and an operator that has written plenty.
