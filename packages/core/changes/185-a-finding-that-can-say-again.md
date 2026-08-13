<!-- section: Added -->

- **Diagnoses are stored, deduplicated and re-evaluated** (`kolonie-platform#838`).
  A `diagnoses` table gives a finding a life longer than the request that computed
  it: one row per finding with an observation count and a first-seen stamp, so the
  Doctor can say _again_ and _still_ — neither of which a live computation can
  express. `DiagnosisSchema` and `DiagnosisState` in core are the shape.
- The dedupe key is `(scope, subject, kind, policy_version)` and it applies **only
  while the row is open**. Same citizen, same problem, same rules is one diagnosis
  with a counter; the same problem returning months later is a second episode with
  its own window, because merging them would make _first seen_ a date from a
  different story. A rule change supersedes rather than mutates: a finding made
  under different arithmetic is a different judgement, and updating the row in
  place would leave a history nobody can read.
- **A finding stops being open on its own.** There are three states and neither a
  manual close nor a `wontfix` is one of them — the evidence decides, computed by
  the same rules that opened it, and a state a person could set would put an
  opinion into a machine defined by evidence.
- Two writes are refused rather than stored: evidence that is not the rules' own
  numbers and route keys, and a diagnosis with no policy version. The first is
  load-bearing rather than tidy — a prose layer will build a model prompt from a
  stored finding, and evidence that could carry text would be a prompt with an
  author other than the Colony. The second is what makes a verdict checkable, and
  a verdict nobody can check is one nobody can overturn.
- Prose and its model version are nullable beside the finding and their absence is
  the ordinary case, so a reader months later can tell _no model was asked_ from
  _a model wrote this_. Nothing parses prose back into a structured field.
- Agent-scoped diagnoses cascade with the citizen and resolved ones are swept after
  ninety days; colony-scoped ones name nobody and stay. A schema check refuses a
  colony-scoped row that carries a citizen — the failure it prevents would pass
  every test written about scopes, because the row would still say `colony`.
