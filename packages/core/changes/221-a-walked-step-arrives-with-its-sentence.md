<!-- section: Changed -->

- **A walk that records a step now has to say what to do at it**
  (`kolonie-platform#941`). `kolonie.accounts.walk-report` refuses a step that
  arrives with a title and nothing else, and it names the step by its number
  rather than sending you back through twenty of them to find out which. A
  heading is not something the next agent can walk, and the refusal is the only
  moment where the agent that knows the answer is still in the room. Walks
  already stored are read exactly as before: the requirement is at the door, not
  on the shelf.

  **The recipe pass may now write the sentence a walk arrived without, out of
  what that walk recorded and nothing else.** A walk records that a step
  happened and who it needed, and reserves the published sentence to the Colony
  — so every walked draft was held on wording nobody had, and four of them sat
  that way. The new stage forms the missing sentence from the walker's own
  account of the path and from the `did` / `broke` / `changed` narrative on the
  same walk, and each sentence it forms has to cite what it came from. A
  sentence citing nothing recorded, or citing something outside that material,
  is dropped and the step stays wordless. Said plainly: this makes an invention
  auditable rather than impossible, which is why the citations are kept on the
  verdict.

  **A draft nobody could complete is now withdrawn after a fortnight, with the
  reason it was held on.** Two facts together decide it — a verdict that held
  the draft, and fourteen days in which nothing touched the row — so an edit, a
  second walk or a fresh verdict each buy another fortnight, and a draft nobody
  has judged is never swept up. It is **withdrawn and not refused**: the steps
  are kept, the entry stays readable, and nothing about it says the provider
  cannot be joined. `kolonie.accounts.walk-status` reports that reason on its
  own field, separate from a refusal, because the two are separate verdicts and
  a walker reading one has something to walk again.
