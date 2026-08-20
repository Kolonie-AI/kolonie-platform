## D-124 — The pull request is the path here, because the change D-070 declined was made anyway and nothing recorded it

**2026-08-16 · kolonie-platform#1077 · supersedes D-070's practice clause**

D-070 removed a required status check from `main` on 2026-08-03 and said why:
_push directly to `main`_ was the recorded practice, a pull-request mechanism
could not gate a direct push, and a rule bypassed on every use tells readers
something false. It named the alternative and left it on the table — "**the
change to make if `main` should genuinely be gated**".

**That change was made, in pieces, and no decision says so.** Read from the API
on 2026-08-16: `main` requires `format, lint, build, typecheck, test` again
(app_id 15368, `strict: false`). An hourly sweep in `kolonie-docs` arms
auto-merge on open pull requests across the organisation, and one of its filters
is _the default branch requires a status check_ — so the check being back is what
makes a pull request here merge itself, and its absence is why a green pull
request in the seven skill repositories sits open until somebody merges it. The
loop D-070 declined exists and is the majority path.

**It is the majority path and not the only one, and the difference is
`enforce_admins`.** That is still `false`, so a direct push to `main` lands.
Measured 2026-08-16 against `origin/main` with
`gh api repos/Kolonie-AI/kolonie-platform/commits/{sha}/pulls`: of the last
thirty commits, **seventeen arrived through a pull request and thirteen were
pushed directly**, the newest of those `26be4b61`, the same day. `#1077` states
that "the last twelve commits are all PR squashes, none a direct push"; that is
not what the read shows, and the correction is the reason this entry does not
simply declare the direct path gone.

**So D-070's practice clause is superseded and its safety argument is kept
whole.** On the direct path nothing runs before the ref moves, the deploy starts,
and CI reports afterwards — `npm run check` before pushing is still the only
thing between a red commit and a deploy, and `kolonie-infra#31` is still what
that costs. What changed is that there is now a path where a check does run
first, and `AGENTS.md` §4 described only the other one.

**Rejected: upholding D-070 unchanged and calling the pull requests drift.**
Seventeen of thirty is not drift, the sweep is built and running, and the
required check was re-added by somebody deliberately. Documentation that calls
the majority path a mistake is the same failure D-070 was written against, in
the opposite direction: it tells a reader something false about a machine that
deploys itself.

**Not decided here: re-adding `enforce_admins`, or otherwise closing the direct
path.** That is a branch-protection change on a repository that deploys itself,
it would strand any workflow or operator that pushes directly, and D-070's own
reasoning says a protection nobody can satisfy is worse than none — so it wants
the same measurement done again, not an inference from this one. What would
decide it: a week in which the direct-push count is zero, and a check that the
deploy path itself does not push.

**What would reverse this**: the sweep being turned off, or the required check
being removed from `main` again — either one leaves an open pull request with
nothing to merge it, and the honest description reverts to D-070's.
