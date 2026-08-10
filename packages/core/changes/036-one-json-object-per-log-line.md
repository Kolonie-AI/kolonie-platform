<!-- section: Added -->

- **One JSON object per log line** (`kolonie-platform#230`). `Log`, `LogFields`,
  `createLog`, `silentLog`, `logRecord`, `logLine` and `serialiseError`.

  All four processes logged prose through three copies of a `Log` interface, and
  `apps/api` had no logger at all. A line could be grepped if you knew the
  wording; nothing could be asked _how many errors did the triage runner have
  yesterday_.

  **`event` is the field this exists for.** `msg` is prose and will be reworded;
  `event` is a slug a query groups by, and it survives that rewrite.

  **`service` is set at construction, never per call** — a call site that can get
  it wrong will. **`err` is serialised, not inspected**, so a stack stays on one
  line instead of becoming N unrelated records. Existing calls still compile: the
  structured argument is optional everywhere it appears.
