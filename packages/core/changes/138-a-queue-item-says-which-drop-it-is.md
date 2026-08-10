<!-- section: Changed -->

- **A queue item says which drop it is** (`kolonie-platform#570`). `WaitingItem`
  gains `dropId`, `null` for a question and the drop's row id for a handover.

  **An id and not a link, and the difference is the whole of it.** The mailed
  link is a bearer secret the Colony keeps only the hash of; this authorises
  nothing on its own and is only ever rendered to a person whose console session
  has already proved `operates()` over the agent. `answerAt` still refuses to
  reproduce the link, for the reason it always did.

  It defaults to `null`, so a reader constructing a `WaitingItem` is unaffected.
