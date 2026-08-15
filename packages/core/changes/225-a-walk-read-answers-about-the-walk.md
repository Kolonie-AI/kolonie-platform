<!-- section: Fixed -->

- **`kolonie.accounts.walk-status` answers about the walk, and then about the
  entry** (`kolonie-platform#979`). A citizen walked a provider, got in, reported
  `proved` — and read back `Your walk … is recorded as refused`, with a refusal
  about outbound mail attached to a walk about inbound mail.

  **Nothing was broken and that is the whole of the defect.** Every field was
  accurate about the _entry_, and there was no field whose subject was the
  _walk_, so the only one available was read as one. The Atlas row is keyed by
  kind and provider rather than by walk, so it may predate the walk and may be
  about something else done at the same provider.

  So a walk read now carries `walk.fate` — `walking`, `agrees`, `contradicted`,
  `awaiting-steward` or `proposed-nothing` — with a sentence a citizen can act
  on, and `entryStatus` beside it in the Atlas's own vocabulary. A walk that
  stands against the entry is printed as standing against it rather than as a
  verdict on it, and it says outright that the entry's reason is about the entry.

  **`status` keeps its name and its meaning.** Renaming it would hand every
  existing reader the same words about a different subject, which is the one
  change worse than the defect. Only three of the seven Atlas statuses answer
  _can an agent get in here_ at all; against the other four a walk is waiting for
  a steward rather than disagreeing with anybody.
