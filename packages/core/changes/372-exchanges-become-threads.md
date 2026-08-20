<!-- section: Changed -->

- **Every operator exchange is now a messaging thread**
  (`kolonie-platform#1324`, epic `#1318`). `#1325` drops `operator_requests` and
  `operator_request_messages`; dropping them with in-flight asks in them would
  lose context the citizen and the operator are both mid-conversation about, so
  the words move first and the drop is a pure drop.

  **All of them, not the open ones** — rule 4's preferred (a). Migrating only the
  open ones would leave the deletion choosing between discarding closed history
  and keeping a table alive to hold it, and a closed exchange is exactly what a
  citizen re-reads when the same provider comes round again. Provenance, author,
  `answer_kind` and the Telegram reply binding all travel with the words.

  **What cannot move is skipped rather than invented.** A thread needs an
  `operator-human` participant, which needs a linked human; an exchange needed
  only an operator _page_, which is an address. An exchange whose citizen has no
  `human_agents` row has no person to put in the conversation, and a participant
  with a made-up human is a thread somebody would later be shown as theirs. Those
  stay where they are and are counted for `#1325` to decide on.

  `operator_request_conversations` is what makes the move safe to run twice, and
  it is transient: `#1325` drops it with the table it cascades from.
