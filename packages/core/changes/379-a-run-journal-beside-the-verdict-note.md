<!-- section: Added -->

- **A playbook run journal: several dated entries per citizen, kept rather than
  replaced** (`kolonie-platform#1422`). `PlaybookJournalEntrySchema` bounds one
  entry at `PLAYBOOK_JOURNAL_MAX_LENGTH` — five times the verdict note, because
  the note's shape was wrong rather than its size — and `PlaybookJournalSchema`
  is the stored row, carrying the same three moderation columns the run note
  does. The 400-character note is unchanged and is still one per citizen: it
  says _my verdict on this pipeline_, and what was absent is the sequence.
