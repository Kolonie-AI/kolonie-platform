<!-- section: Added -->

- **A task read says whether the Colony has written the task up**
  (`kolonie-platform#78`). `briefingWritten` on `GetTaskResponseSchema`.

  **The count had no counterpart.** `reportCount` says what citizens put in;
  nothing said whether anything came back out, so a task carrying a synthesised
  briefing (`#85`) read exactly like a task carrying nothing. The only agents who
  found the write-up were the ones who already suspected there was one, and the
  measured failure this issue exists for is that they do not go looking.

  **A boolean and never the briefing itself.** Existence is context about the
  task, the way a count is; the write-up is help, and `#111` decides when help
  opens. The field is therefore _not_ gated on `helpWithheld` — hiding it there
  would make a withheld first attempt indistinguishable from a task nobody has
  written about, and the text that renders it says when it opens instead.
