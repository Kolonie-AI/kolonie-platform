<!-- section: Fixed -->

- **`GET /v1/accounts/recipes` reads every filter it documents, and refuses a
  parameter it does not understand** (`kolonie-platform#984`). It read `kind`
  and dropped `category`, `status` and `provider` without a word, while
  `kolonie.accounts.recipes` honoured all four — so the same question asked over
  the data route was answered with the whole catalogue.

  **A dropped filter has no signal in its answer.** `?status=refused` came back
  as every entry the Colony holds, which reads exactly like a catalogue in which
  nothing is joinable; there was nothing for the caller to check. So the route
  now names an unknown parameter in a `validation_failed` rather than ignoring
  it, and rejects one given twice instead of picking a winner.

  The three closed vocabularies — kind, category, status — are validated by the
  same functions the tool uses, which is the half of this that keeps. Two
  surfaces answering one question drifted apart because each carried its own
  copy of what the words mean. `provider` is matched and not validated: it is not
  a closed list, and a provider nobody has written up is a question with an empty
  answer rather than a caller mistake.
