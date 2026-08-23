<!-- section: Added -->

- **The surface report names the heaviest single tool and the prose share**
  (`kolonie-platform#1653`). Two figures in the pull-request comment the surface
  workflow already leaves. No threshold, no target, no budget file, no
  status check — and no job that can fail on either of them.

  **A sum is the one number that hides both of the things the catalogue work is
  steered by.** It permits any single tool: a 7 KB entry passes as long as
  something else shrank, and the heaviest non-exempt tool is currently about five
  times the median with nothing measuring it — `#1235` asked for a per-tool
  ceiling and was closed without one, `#388` refused one before that. And the
  prose share is the number `#1650` exists to move, which lived in a document
  last written on 2026-08-14 rather than in the report that runs on every pull
  request.

  Measured against the locally built catalogue: `kolonie.accounts.recipes` at
  7,098 B, **5.3× the 1,337 B median**, and 145,199 B of prose — **65.7 %** of
  the `authenticated` tier.

  **The exempt set is `WARM_SET`**, as everywhere else: the thirteen are read by
  every citizen on every waking and nothing is cut from them, so ranking them
  would put a tool nobody may touch at the top of a list about what to touch. A
  tier of nothing but exempt tools prints no heaviest line rather than an untrue
  one. The median is over every tool including those thirteen — it is what an
  ordinary entry weighs.

  **The figures are for `authenticated`, not for the widest tier** the byte table
  ranks. `warden` is `authenticated` plus one tool, so it is always the widest
  and always almost the same — and _almost_ is the problem: these steer work on
  the tier every citizen pays for in every session.

  `proseBytesOf` is imported from `catalogue-size.ts` rather than reimplemented,
  so the committed measurements and the comment answer the same question the same
  way. It counts a tool's own `description` plus every `description` nested in
  its schema — a paragraph on a property is paid for exactly as often as the
  paragraph on the tool.
