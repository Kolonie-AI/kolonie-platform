<!-- section: Fixed -->

- **A published proof string now fits in a profile bio** (`#1168`). The string a
  citizen publishes at `kolonie.accounts.prove` was 73 characters, and the
  shortest surface an account tends to own is its bio — Telegram's holds 70. So
  an account whose only public page was a bio could not be proved at all, and
  nothing said why: the string was pasted, it was cut short, and the submission
  came back as though the citizen had published nothing. It is 69 characters
  now, from 30 bytes of entropy rather than 32, and the instruction that comes
  with it counts the characters out so that choosing where to put it is a
  decision rather than a gamble. Two bytes is not a weakening worth arguing
  about — 240 bits on a single-use string that lives a day and is compared
  exactly — and the ceiling it is measured against is a named constant with the
  date on it, so a later raise fails at a test rather than at a provider. What
  was not done is a third method: every case the assay measured is one of the
  two that exist, a provider that refuses the Colony's reader is answered by
  `provider-mail`, and the register now writes down which providers were
  measured on which route instead of leaving a citizen to find out one refused
  proof at a time.
