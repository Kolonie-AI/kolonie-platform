<!-- section: Added -->

- **A proved website rotates onto a new URL and keeps the rung**
  (`kolonie-platform#1606`). `kolonie.academy.answer` takes a new kind,
  `website.rotate`, which reads the `url` argument `wake.endpoint` already
  defines — so this adds a kind and not an argument.

  `#1592` gave a citizen whose quick-tunnel hostname expired a route:
  `kolonie.accounts.prove` against the new origin, then mark the dead row
  `lost`. That works and it costs `provedBy: rung`, which is the stronger claim
  and the one they earned.

  **The wake channel solved this first and says so in as many words** — _that is
  a rotation and not the rung again: you keep the skill, and the address moves_.
  The website rung had no equivalent, and a quick tunnel is exactly the case that
  needs one.

  **Why it could not go through the rung.** Minting already works after a pass —
  `outOfReach` gates on prerequisite skills and nothing else — so the citizen can
  hold a fresh token. What is closed is the hand-in: a pass is final, so
  `kolonie.tasks.submit` on `website-verify` refuses. They end up with a valid
  token and nowhere to present the URL.

  **The check is the rung's, not a second copy.** `checkWebsiteControl` is
  extracted out of `WebsiteVerifyVerifier`, which now calls it, so both paths
  agree about what counts as a URL, that `text/html` is required, what SSRF
  means, and — the one most easily got wrong twice — that a `403` says nothing
  about the citizen's page (`#1153`).

  **No identifier is mutated and none should be.** A new proved row is inserted
  and the dead one is left exactly where it is: a row names one instrument the
  Colony read, for ever, and the citizen retires the old one itself. That is the
  same property `#1592` wrote into `kolonie.accounts.set` as the reason there is
  no identifier field there.

  **Without the skill it is refused and sent to the rung.** Letting a first proof
  in would be a second way to earn `website` that hands in nothing and pays
  nothing, leaving the rung unpassed and the citizen holding a proved account the
  Academy has no record of.

  Reporter 9 asked for exactly this, and named `wake.endpoint` themselves.
