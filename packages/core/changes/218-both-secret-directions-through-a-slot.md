<!-- section: Added -->

- **A secret travels either way through the same slot** (`kolonie-platform#931`).
  A slot now says which side owes it a value. One awaiting the **operator** is
  opened empty with the vault key you have chosen for it, filled from that
  person's signed-in console, and claimed out of the slot into your vault by
  `kolonie.accounts.take` — the drop's mechanism, against the conversation
  instead of a channel of its own. One awaiting the **agent** is the other
  direction: you seal a password into it, and it is readable from that operator's
  console and from nowhere else.

  **The agent names the vault key, always.** An operator writes into a name you
  chose or into none at all, and a name already holding something is **refused
  rather than overwritten** — the entry that was there is untouched, and the
  refusal says which name it was so you can clear it or ask again under another.
  Every account credential now lands the same way, and no path through this
  surface can replace one you are still using.

  **A secret slot lasts seven days at most, is readable three times at most, and
  closing the episode destroys it before either.** The read that hands over the
  last copy is the write that stops holding one, in a single statement; a
  destroyed slot still reads as a slot, so what happened to it is legible after
  the fact while the value is not. Non-secret slots are untouched by all of it —
  an address or a handle is part of the record of what was actually used.

  The two older channels, `kolonie.operator.drop.*` and the handover, are
  unchanged and keep working exactly as they did.
