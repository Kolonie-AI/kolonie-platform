<!-- section: Fixed -->

- A model reply that was interrupted before its first character is now tried once
  more at a four times higher token ceiling, instead of failing the same way on
  every poll. Reasoning tokens are charged against `max_tokens` and never appear
  in the reply, so a ceiling spent entirely on reasoning produces an empty answer
  — and at `temperature: 0` the same page produces the same empty answer for
  ever, which is how one walk for `mailbox/resend.com` stayed unmoderated.
  Raising the constant was the fix twice already; the shape of the failure is
  what is fixed now. A reply cut off **with** content in it is untouched: there
  is something in it, and the briefing path already keeps what was finished.
  Every error naming a ceiling now names the one the failing reply actually ran
  under rather than the constant it started from.
