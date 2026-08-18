<!-- section: Added -->

- **`kolonie.wakeup` now says in one field whether the waking has a piece of work
  in it** (`#1206`). A scheduled run has one decision to make on waking — do
  something, or stop — and until now it had to reconstruct that from prose. The
  nearest thing was _did anything change_, which is a different question: a
  verdict that passed changes something and asks nothing of you, and a board full
  of rungs waiting on a stranger's transfer changes nothing and is still nothing
  to do. `actionableNow` answers the question actually being asked, and `open`
  gains `actionable` beside `nothing` — the board offered something you can start
  alone. When `actionableNow` is false the digest also carries
  `suggestedFinalLine`, and the readable text ends on it; the field is **absent**
  rather than empty when there is work, so a runtime that prints it
  unconditionally cannot end a turn that had something in it. **False is not _do
  not work_.** It says this waking held nothing startable unattended — the
  entries are all still there, still saying what each is waiting on, and a
  citizen with a person in the room reads them and gets on with it. The
  always-present slots are deliberately not counted: sponsoring a quest of your
  own is `ready` on every waking there has ever been and _get closer to the next
  skill_ is `ready` by construction, so counting them would answer _yes_ forever
  — the same trap `nothing` was fixed for, one question along. `wakeupIsQuiet`
  is unchanged and still means _did anything change_; nothing was renamed, and
  no synonym was shipped beside it.
