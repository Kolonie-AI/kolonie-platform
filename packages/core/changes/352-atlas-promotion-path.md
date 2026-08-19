<!-- section: Added -->

- **Where an Atlas entry stands on the way to being a route, and whose move is
  next** (`kolonie-platform#1303`, epic `#1295`). `#1032` decided that walker
  prose is never published as **the** Colony route, and left a catalogue where
  most entries say _walked, but no route written yet_ with nothing anywhere
  saying how one gets written. A citizen reading a thin `measured` page could not
  tell whether it was waiting on itself, on a moderator, or on a steward who had
  not looked. `atlasPromotionOf` derives five stages — `sighted`, `walked`,
  `route-offered`, `joinable`, `closed` — and each carries **whose** move it is:
  `citizen`, `steward` or `nobody`. `kolonie.accounts.recipes` prints the
  sentence under each row's figures and above its prose, which is where it
  decides whether the paragraphs below are worth reading.

  **Nothing here promotes anything.** The only call that makes an entry
  `joinable` is `dressEntry`, from the console, by a person, and that is the
  property `#1032` protects. `route-offered` says a cleared walker route is
  readable and a steward has not decided; it does not queue, schedule or imply
  the decision, and the sentence says _has not adopted_ rather than anything a
  reader could take as a promise. Stages are derived on every read and stored
  nowhere, so there is no column that can disagree with the rows it came from.

  **Attempts and not proofs decide whether there is a corpus.** A provider ten
  citizens were refused by has the evidence most worth writing out — the route
  that matters there is the one saying where it stops — so counting only the
  successes would report `sighted` for the entry with the most behind it.

- **A playbook says what the Atlas has on the providers it pinned**
  (`kolonie-platform#1303`). A `requiredAccounts` slot may name a `provider`, and
  nothing checked that the catalogue had heard of it: a pin to a refused or
  absent entry still produced an `atlasPath` hint, so a citizen followed the
  playbook to the Atlas, met a thin or refused page, and came back — with nothing
  naming the pin as the thing to look at. `kolonie.playbooks.draft` and
  `.update` now read each pin against the catalogue and hand the author
  `atlasPins` beside the playbook, with a line per pin worth remarking on.

  **Surfaced and never enforced.** The draft is written either way: a playbook
  may legitimately pin a provider nobody has walked, because its author walked it
  or is writing ahead of the catalogue, and refusing would make the Atlas's
  coverage a gate on somebody else's work. A supported pin says nothing at all —
  a note on every draft is a note an author learns to skip, and the ones that
  matter would be skipped with it. Pins are resolved through the rename table
  first, so an alias is read against the entry the Colony files it under rather
  than reported absent.
