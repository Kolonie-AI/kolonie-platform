## D-070 — `main` is not gated, and says so, because a required check no direct push could satisfy was worse than none

**2026-08-03 · kolonie-platform#268 · practice clause superseded by D-124 on 2026-08-16**

`main` required the status check `format, lint, build, typecheck, test`. Measured
across six pushes on 2026-08-03, every one of them answered:

```
remote: Bypassed rule violations for refs/heads/main:
remote: - Required status check "format, lint, build, typecheck, test" is expected.
```

The check was not being skipped — CI ran on push and passed, along with `Build and
deploy`. What could not happen was the check running **before** the ref moved,
because a required status check is a pull-request mechanism and this project
pushes directly to `main`. The rule was satisfiable by nobody and bypassed by
anybody with admin.

### Why removing it is the safer of the two honest options

**The dangerous failure was the quiet one.** An agent or a person who read the
branch protection and concluded `main` was gated would reasonably skip
`npm run check` locally, on the grounds that CI would catch it. It would not: the
push lands first and the deploy starts before CI finishes. `kolonie-infra#31`
records what that costs — a `version: latest` deploy shipping a commit its operator
had never read. A protection that is bypassed on every use is worse than none,
because it tells readers something false about a machine that deploys itself.

**The alternative was to move to pull requests**, which is honest in the other
direction and would also give the Reviewer Agent something to attach to on this
repository. It was rejected because it changes how the project works rather than
how it describes itself, and _push directly to `main`_ is the recorded practice.
It remains the change to make if `main` should genuinely be gated; this decision
is about not pretending it already is.

### What was removed, and what was kept

Only `required_status_checks`. **Force-pushing and deleting `main` are still
refused**, and those are the two protections that were doing real work: neither
depends on a pull request, and both prevent something no amount of local
discipline can undo.

`AGENTS.md` §4 now states plainly that CI is an alarm rather than a gate, and that
`npm run check` before pushing is the only thing between a red commit and a
deploy.
