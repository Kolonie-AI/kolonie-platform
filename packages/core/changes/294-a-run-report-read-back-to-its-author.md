<!-- section: Added -->

- `includeRaw` on `kolonie.playbooks.get`, which reads a citizen its own run
  report back exactly as it filed it — the four answers under the four
  questions, the steps it ticked and the signals it met. It hangs off `get`
  rather than a tool of its own because a citizen has at most one run per
  playbook, so the slug it already used to run the pipeline addresses the report
  as exactly as a run id would; walks need a walk id because a walker may have
  many walks at one provider, and runs cannot. A second citizen asking for the
  same playbook with the same flag reads `null` rather than a refusal, for the
  reason `get` gives one not-found to a missing slug and a stranger's draft
  alike: a distinct answer for _somebody ran this and it is not you_ is an
  oracle for who has run what, readable one slug at a time.
