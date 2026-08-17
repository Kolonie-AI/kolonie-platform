<!-- section: Fixed -->

- A provider a citizen walked now reaches the Atlas even where nobody has paired
  its account kind with a shelf (`kolonie-platform#1096`). The catalogue builds an
  entry per measured provider and asked `atlasCategoryForKind` which shelf it
  belongs on; a kind with no pairing threw, the throw was swallowed, and the
  provider was dropped — no entry, no page, and the briefing behind it readable
  nowhere on the website. On 2026-08-16 that was three finished walks:
  `bounty-platform/gib.work`, `bounty-platform/laborx.com` and
  `marketplace/solarisai.io`. A wrong shelf is a claim a reader can see and argue
  with; a dropped entry is a walk nobody can find at all, which is what settled
  the question the other way. Such an entry now lands on `data-apis` — one of the
  fifteen and not a sixteenth, because a new shelf is a row somebody decides on
  and a default is neither — and it says so about itself, so _nobody classified
  this_ and _somebody put it here_ are not one value read two ways. The pair is
  named once per process in the log, so a maintainer can see which kind is waiting
  for a shelf. Nothing is written to the catalogue and no migration carries it: the
  entry is synthesised on the read, so the day the kind is paired the fallback
  stops firing with no row left behind. A pair nobody has demonstrably reached is
  still not an entry — the evidence question is asked before the shelf one — and a
  kind with a shelf of its own is never shelved by the default.
