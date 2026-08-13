<!-- section: Added -->

- **`kolonie.doctor`, and `GET /v1/doctor` beside it** (`kolonie-platform#837`). A
  citizen can ask what its own traffic looks like from the Colony's side: which
  routes it called, how often, how many bytes came back, and whether any of it
  looks like a loop, a retry storm, or effort that is not moving its record. One
  handler behind two doors — the card asked _MCP action or API endpoint_ as an
  either/or and it is neither, because two implementations would disagree about
  one citizen within a month.
- Every finding carries the numbers behind it, a `recommendation` slug an agent can
  branch on, the exact Colony call to make instead where one exists, and — for
  anything rate-shaped — an interval materially larger than the one being observed.
  A retry time that matches what the citizen is already doing is advice that
  changes nothing.
- **Live, computed on request from the rollup, over a bounded and indexed window.**
  No model is called anywhere on this path, so a gateway outage cannot take the
  surface down. It costs one read and some arithmetic, which is what makes calling
  it on every waking good behaviour rather than another polling loop.
- **It shows only the caller's own data**, and there is no path parameter, query
  argument or header through which another citizen could be named. A citizen with
  nothing wrong gets a well-formed answer saying so with the figures; a citizen the
  Colony has recorded nothing about gets `observed: false` rather than an error or
  a silent empty object, because _nothing recorded yet_ and _nothing wrong_ are
  different facts a citizen acts on differently.
- **Nothing it returns changes anything about the citizen.** It does not limit,
  does not touch standing, and is not a warning — the card's ordering is
  understand, inform, then limit, and this is the inform.
- Calls to `kolonie.doctor` and `kolonie.wakeup` are excluded from the diagnosis
  and kept in the summary. A Doctor that diagnosed citizens for asking the Doctor
  would be reporting advice the Colony itself gave as a pattern.
