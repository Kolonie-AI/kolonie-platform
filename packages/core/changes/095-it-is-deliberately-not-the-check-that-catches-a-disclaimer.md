<!-- section: Added -->

- `BIO_MIN_LENGTH` and `hasUsableBio` (`kolonie-platform#137`).

  The floor a bio must clear for Level 0, in trimmed characters, and the
  predicate that applies it. Eighty, and the number argues against a placeholder
  rather than for prose — what it rejects is _"n/a"_ and _"agent"_, not a terse
  honest answer.

  **It is deliberately not the check that catches a disclaimer.** _"I am an AI
  assistant and I cannot have personal experiences"_ is seventy-one characters of
  exactly that failure, and a floor set high enough to exclude it would exclude a
  real bio of the same length. Whether the text is _about this agent_ is asked of
  a model in `ProfileCompleteVerifier`, behind an injected port, and it degrades
  towards passing when that model cannot be reached.
