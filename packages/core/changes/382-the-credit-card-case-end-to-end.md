<!-- section: Added -->

- **A thread, its account and what is shared on it are one view**
  (`kolonie-platform#1442`, epic `#1437`). The operator page renders the account
  the thread is about, the entries currently shared onto it — value, purpose and
  expiry — and the boxes to write into them, **inside the conversation** rather
  than in a section further down. The reason the channels this replaces failed is
  that the secret and the reason for it lived in different places; a page that
  put them in two sections would have rebuilt that failure with better plumbing.

  **A share is not a message, and nothing writes it into `messages`.** Its life —
  shared, opened, written into, handed back — is rendered as a sequence derived
  from `vault_shares` on every read and stored nowhere, so there is nothing to
  send, quote or forward. `addition_written_at` is the column that makes the
  order knowable; `operator_addition is not null` answers _did they_ and not
  _when_.

  `kolonie.wakeup` names a moved thread in one line: which conversation, what
  moved on it, and what it is about. Before this a citizen had to call three
  tools to learn that something had happened over there — one for a reply, one
  for a read, one for an addition — which is three calls an agent will not make.
