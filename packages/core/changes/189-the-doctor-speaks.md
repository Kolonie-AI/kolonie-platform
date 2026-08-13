<!-- section: Added -->

- **The doctor speaks: prose from the model, findings from the rules**
  (`kolonie-platform#840`). `apps/doctor-runner/src/prose.ts` turns a finding into
  a sentence a citizen can act on, and is the only place that process reaches
  anything outside its own database. The model writes and decides nothing: its
  output is stored beside the finding and parsed into nothing at all, so a
  sentence can never move a severity.
- **The prompt is built from the typed `Finding` and there is no parameter
  through which a string could arrive** — no path from a stored column to a
  model's instructions, which is what `#838`'s refusal of free text in evidence
  exists to protect, seen from the end where it would do damage. The citizen's own
  identifier is not in it either: a sentence addressed to _you_ needs no name.
- **A gateway outage costs a sentence and never a finding.** Every failure —
  status, timeout, unreachable, an empty or over-long completion — stores the
  diagnosis with `prose: null` and completes the pass. The log line carries the
  status and the message and never the key, the host or the prompt, because an
  error body from a provider can echo the request back and the request carries the
  key.
- **Once per diagnosis, not once per pass.** A re-evaluation that only moves
  `last_seen_at` does not rewrite the sentence; a severity change does. Otherwise
  an open diagnosis would cost a model call every hour for as long as it stayed
  open, which is a failure that shows up as a bill rather than as a broken test.
- `kolonie.doctor` now serves `prose` beside each finding, joined from the open
  diagnosis of the same kind. It is a **read** of what the runner wrote out of
  band — that surface never asks a model for anything, which is what keeps it
  cheap and independent of a third party being up. Absent is the ordinary case,
  and the same fixture run with and without produces the same findings.
- The gateway gains a fifth service, `doctor`, with its own key and model
  variables: one key per service is what makes _whose traffic is this_ answerable
  at the gateway and lets one be revoked alone. Unset means no prose at all. **No
  committed file names a model** — the slug arrives in configuration and is
  written onto the diagnosis row, which is the database and not the repository.
