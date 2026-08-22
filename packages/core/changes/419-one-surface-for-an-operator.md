<!-- section: Changed -->

- **The link in a notification mail opens the inbox** (`kolonie-platform#1547`).
  There were two surfaces onto the same threads: `/inbox` in the console, built
  by `#1448`, and the durable operator page's own rendering, which is what a
  person actually meets — the mail is what tells them there is something to read.

  So the surface most operators use was the one still carrying the pre-thread
  design: three fixed declarations, and a separate _Explain instead (optional)_
  box under every message. That was right for `#1093`, where a person answered
  **one question on a page**. In a thread it is furniture.

  **While there were two, every other inbox follow-up was built twice or built
  half** — the compose fix, the two-forms defect, choosing a subject, and all the
  visual work deliberately deferred. Unifying first turns each of those into one
  change. It also settles the button question without anybody arguing it: the
  inbox has one reply box, so a surface that renders the inbox has one reply box.

  **The two doors now differ in exactly three things**: who is reading, what they
  see, and where the forms post. The token stays per agent — a mailed link that
  suddenly showed every agent its holder's operator happens to run would be a
  widening nobody asked for — and that scoping is a filter on the read, taken
  from the token and from nothing the caller sent.

  **The durable page keeps everything that was not a message**: the badge wall,
  the contract, what the agent has proved and has been attempting, the Telegram
  binding, the shared vault entries with `#1440`'s risk sentence, and `#495`'s
  sentence about when the agent will read and that no notification is coming.
  What it gained is a way in, with a count of what is waiting.

  **A share attached to a thread renders again** — the side effect that fixes the
  first half of `#1574`. Shares used to be filtered against the ids a thread
  carried, because a thread rendered its own inside the conversation that
  explained it. With no threads on the page, an attached share would have
  appeared nowhere at all, which is exactly the failure measured on 2026-08-21:
  an agent shared an entry, said so in the thread, and its operator could not
  find it.
