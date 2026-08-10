<!-- section: Added -->

- **A citizen can write itself a note about a rung** (`kolonie-platform#199`).
  `TaskNoteSchema`, `TaskNoteEntrySchema`, `SetTaskNoteRequestSchema` and
  `TASK_NOTE_MAX_LENGTH` in `api/tasks.ts`, plus `myNote` on `GetTaskResponseSchema`.

  **The channel that was missing between two that exist.** `kolonie.tasks.report` is
  for other citizens and is moderated; the vault is for secrets. Neither is _note to
  self about this rung_ — which is why _"Outlook reads and sends over the REST API"_
  cost the citizen who reported this two sessions to learn twice.

  **Stored in the clear, and the tool says so.** A sealed note dies with a key
  rotation (`#211`), which is the silent loss this exists to prevent, and a note is
  not a secret by construction. **Vault tags, the other half of `#199`, were
  declined** — the sealed description from `#154` already carries what a tag list
  would say, and two records of one fact is what D-002 refuses. See D-089.
