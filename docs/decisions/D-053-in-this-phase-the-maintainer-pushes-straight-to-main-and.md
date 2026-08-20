## D-053 — In this phase the maintainer pushes straight to `main` and the required status check is bypassed on purpose

**Decided 2026-08-02**, with the maintainer, after a session that closed ten
citizen-reported issues in one afternoon.

### What is true, and it looks like a defect

Every push to `main` reports:

```
remote: Bypassed rule violations for refs/heads/main:
remote: - Required status check "format, lint, build, typecheck, test" is expected.
```

There is no pull request, so nothing is reviewed before the change is on the branch
that deploys. The Reviewer Agent (`review.yml`) calls
`kolonie-docs/.github/workflows/review-pull-request.yml`, which is exactly what its
name says: it reviews **pull requests**, and this path never opens one. It runs after
every CI run, finds nothing to review, and exits clean. That is the reviewer doing its
job — it was built for a citizen's pull request (`kolonie-docs#42`) — and it means the
maintainer's own commits are reviewed by nobody.

**A required check that is never required, and a reviewer that reviews nothing,
together look like two things somebody forgot to finish.** That is why this entry
exists. `D-033` opens with the same worry in a smaller place: _a shape that looks like
an oversight gets "fixed" by whoever notices it next._ Without a record, an agent will
eventually close this gap out of diligence, in the middle of the phase where it is
deliberately open.

### The decision

**Direct pushes to `main` stay, and the bypass stays, until citizens are contributing
code.** No branch, no pull request, no waiting.

### Why, and the number that argues it

The Colony has one maintainer and a board that several agents work at once. Measured
on 2026-08-02: ten issues taken, built, tested and closed in a single session, each
one a citizen's report answered in the issue that reported it. A pull-request cycle
per change, with one human able to approve, would have converted that afternoon into
a queue — and the citizens who filed those reports are watching the issues through
`kolonie.support.read`, so the cost of the queue lands on them rather than on the
process that imposed it.

**The safety this trades away is smaller than it looks, but it is not nothing.** CI
still runs on every push to `main` and has been green; what the bypass removes is the
_ordering_ — the verdict arrives after the push rather than before it. That is
acceptable while the branch is worked by one maintainer who runs the same command
locally first, and unacceptable the moment somebody else's commit can reach it.

### What stands in for review while this holds

Nothing checks the maintainer's changes, so two existing habits stop being tidiness
and become load-bearing:

- **`AGENTS.md` §7's claim comment**, which requires saying _which parts of the issue
  you are taking and what you are deliberately leaving out_. With no reviewer, that
  sentence is the only place a scope decision is visible to anybody else. On
  2026-08-02 four of eleven issues were extended past what was filed — each defensible
  and each declared — and the declaration is the whole reason that is recoverable
  rather than discovered later.
- **The doc comment carrying the argument**, not just the behaviour. It is the only
  form of review this repository currently receives, and it is self-review — which is
  worth much more written down than held in a head, and much less than a second
  reader.

Both were already required. What changes is that they are now the mechanism rather
than good manners.

### What reverses this

**Citizens contributing code.** The intended successor is already named: citizens open
ordinary pull requests, and a workflow or coding agent reviews and merges them
automatically. When that arrives, this entry is amended rather than a new issue filed —
the shape of that review is undecided, and an issue for an undecided design would be
noise on a board that is currently healthy.

The trigger is stated here in advance on purpose, so the change is made because the
condition was met rather than because somebody noticed the bypass and read it as a
bug.

### Not covered by this

`#225` — `cancel-in-progress` in `ci.yml` can discard the CI run for an intermediate
`main` commit. That is a separate matter and is **not** settled by this decision:
whatever is true about _who reviews_, a commit already on the branch that deploys
should have a verdict. It stays open.
