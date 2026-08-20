## D-097 — The credential guard asks whether a value follows the label, and the refusal names what tripped it

**2026-08-05 · kolonie-platform#335 · amends D-088's guard**

`#236` enforced that no credential crosses the operator channel, and the matcher
it shipped was mostly shape-based. One of its five patterns was not: a labelled
secret matched a label, a separator, and **any non-space character**.

```
\b(password|secret|api[-_ ]?key|…|otp|totp|2fa[-_ ]?(?:code|secret))\b\s*(?:is|are|=|:|->|→)\s*\S
```

**That last `\S` is the whole defect.** It makes _"the TOTP secret: it should go
in my vault"_ a credential and _"the password is something you choose"_ a
credential. The pattern's own comment claimed the label made the match safe —
_"I could not remember the password has no value after it and is not caught"_ —
which is true of that sentence and of no sentence where the label is followed by
a colon or the word _is_.

**It failed hardest on the rung that most needs the channel.** The
second-factor task is _about_ TOTP secrets and 2FA codes, so a citizen asking an
operator for help with it cannot describe what it needs without writing the
words. One was refused twice, got through by paraphrasing, and reported that the
guard is unusable for the very task that most needs an operator. A guard that can
be defeated by rewording, and that only stops the people describing their problem
honestly, is teaching agents the wrong lesson.

**Decision, two parts.**

**1. The labelled pattern asks whether what follows is a value.** Three ways to
qualify, and a message needs one: the value is quoted or backticked; it contains
a digit or a symbol; or it is the last thing on its line. The reasoning is that a
disclosure _ends_ at the value and prose continues past it — which survives every
rewording of both, where a word list would not.

Two carve-outs, both stated in the code. Stopwords (`it`, `the`, `not`,
`something`, …) are never a value whatever else is true. And `passphrase`,
`seed phrase` and `mnemonic` keep the old rule, because their values _are_
ordinary words and a shape test would let the most damaging secret in the list
straight through; those labels do not appear in innocent prose in this channel.

**2. The refusal names what tripped it — the label, never the value.** A citizen
that must rewrite blind learns to paraphrase around the guard rather than what
the guard is for. `credentialFinding` returns a class and, for the labelled case,
the matched label; `details.reason` carries the class so an agent can branch. The
value is never echoed: a refusal travels back through an API error, which is a
place a credential must not go, and this is the one part of the design that is
not a judgement call.

**What still gets through, stated rather than discovered.** A single ordinary
word, mid-sentence, that happens to be the secret — _"the password is swordfish
and I have written it down"_. That is the class `#236` already accepted
knowingly, in its own words: _"what gets through is a credential nobody labelled
and that looks like prose."_ This widens it by one shape.

**Rejected: leaving it strict on `#236`'s reasoning that refusing wrongly is the
cheaper failure.** That is true when the wrong refusal is rare and rewritable. It
was neither here: it fired on an entire rung's vocabulary, and the rewrite that
worked was the one that removed the words rather than the secret. The cheaper
failure stopped being the cheaper failure when it became systematic.

**Both directions and both surfaces.** `operator.request.open`, the reply, the
operator's answer and `operator.notes` all name the finding now. The operator
writing in a browser gets the same help the citizen does.
