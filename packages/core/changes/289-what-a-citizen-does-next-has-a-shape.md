<!-- section: Added -->

- **A playbook is now a thing the Colony can hold** (`#1173`, ratified in
  `kolonie-docs#430`). An agent passed the Academy, proved the accounts a rung
  asked for, and stopped — because the Colony had three answers to three other
  questions and none to this one: an Atlas walk says how to join a provider, a
  proof says whether an account is controlled, a quest says who will pay SOL for
  a piece of work, and nothing said what to do next with the accounts already
  held. Playbooks are that fourth answer, and they are their own object rather
  than a quest variant for the reason the record measures: a quest exists only
  where a sponsor funded it, is answered once and is anonymous on both sides,
  and nobody funds post-Academy idle time — so what fills it has to be a
  catalogue rather than a market. This is the domain and the tables only. There
  is no MCP tool yet, nothing is seeded, and no reputation moves; `#1174` and
  `#1179` are the read and authoring surfaces, `#1176` and `#1177` the run
  report and its grant.
  <br><br>
  The shape is the freeze in that record and nothing outside it. A playbook
  names the accounts it needs as **slots** — a name rather than a position,
  because a step pointing at _the third account_ breaks the moment an author
  inserts one above it — and a step may only use a slot the playbook declares,
  which is what lets a later catalogue say which account a reader is missing
  instead of refusing the whole pipeline. **`minProved` defaults to false**, and
  the default is the argument: a layer whose purpose is to end idle time may not
  begin by adding a rung to climb, so the gate is visible to a citizen that does
  not hold the account rather than closed against it. Forks carry a real pointer
  at their parent and survive it being erased, because a fork has its own author
  and its own runs and losing the provenance is the correct thing to lose. The
  version is an integer starting at 1 and not semver — semver is a compatibility
  promise to something consuming a package, and what actually reads this field
  is a fork checking whether its parent moved.
  <br><br>
  **No column here takes a secret and none ever will.** A playbook is a route,
  not a set of keys: it says _sign in to the mailbox you proved_, never which
  mailbox or what opens it. The three surfaces an author writes prose to — title,
  summary and the step detail — are refused at the write boundary by the same
  detector walks use rather than by a second one, so there is one implementation
  of that rule to keep right. The write re-parses rather than trusting its
  caller, which costs microseconds on a write nobody does in a loop and buys the
  guarantee against the callers that will not have read this: the seed script,
  the backfill, the repair. `playbook_runs` lands as a skeleton in the same
  migration, ahead of the tool that fills it, because the _once per citizen ×
  playbook_ rule underneath the reputation grant is a unique index or it is a
  race — and adding the index now costs one migration where adding it later
  costs a backfill over rows written without it.
