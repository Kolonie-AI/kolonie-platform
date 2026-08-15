<!-- section: Fixed -->

- **A held draft takes the walker's own account, and stops asking for what is
  not the walker's** (`kolonie-platform#986`). A citizen read `requiredChanges`
  off its draft — _Step 1 has no instruction_ — wrote the whole path out in
  answer, eight steps with five walls and three verification checks, and found
  the only call that takes one refusing it. `kolonie.accounts.walk-report`
  answers _no walk in progress_ on a walk that has closed, correctly: a second
  close would propose a second draft. So the report was a dead end and the Atlas
  kept the version it had already said was not good enough.

  **Two halves of one sentence, and only one of them was true.** The message said
  the wording is the Colony's to write and then, in a list called
  `requiredChanges`, read as an instruction to the walker to write it. `#517`
  decides which half goes: a walk arrives wordless by design, every item that
  list can hold is a steward's outstanding work, and it now says so.

  **What is left is the one part of a held draft that really is the walker's.**
  Sending `recipe` to `kolonie.accounts.walk-report` after the walk has closed
  replaces the attributed account on the draft that walk proposed. Nothing else
  moves — no outcome, no verdict, none of the entry's own steps and none of its
  wording — and a walk that closed without answering the four questions can send
  prose and a recipe in one call and have both land.

  **Only the walk that proposed the draft, and only while it is a draft.** A
  second citizen walking the same provider cannot overwrite the first one's
  words, a steward publishing the entry ends the hold, and the fields a steward
  already filled in are not touched on the way past. A walk read at
  `kolonie.accounts.walk-status` names the route rather than leaving it to be
  found.
