<!-- section: Removed -->

- **`operator_notes` is dropped** (`kolonie-platform#1512`), the next deploy
  after `#1454` stopped reading it, which is the last sentence of
  `changes/392` carried out. `0337_the_operator_note_is_a_thread_now.sql` is the
  drop; the schema file, its barrel export and `OperatorNoteIdSchema` go with
  it. The id brand had no consumer left and nothing had taken it — it existed so
  a row could be pointed at from a test and a log, and there is no row.
  **`WriteOperatorNoteSchema` in `packages/core/src/operator/page-write.ts`
  stays and is not a leftover**: the box on the durable page still validates
  through it, and what it writes is a message. **The three rows are gone with
  the table and were not migrated**, decided in `#1454`: three, all delivered
  and all read, and a migration converting them into threads would have been
  more code than the rows are worth. This is what makes that final.
