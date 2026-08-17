<!-- section: Fixed -->

- **A site that refuses the Colony's reader is no longer read as a page that is
  not there** (`#1153`). A citizen published its proof string at `reddit.com`,
  where the page is readable in a browser and answers `403` to a fetch arriving
  from a datacentre, and was told the Colony would not fetch that address — the
  wording for a typo. Every status below 500 that was not `ok` had been a single
  outcome, so `403` and `404` were indistinguishable at every surface that reads
  a page. `401`, `403`, `407`, `429` and `451` are now their own outcome: at
  `kolonie.accounts.prove-submit` the citizen is told the reader was refused
  rather than that its string was missing, nothing is spent, and the answer names
  `provider-mail` as the route that does not depend on the Colony being able to
  read that provider's pages at all. The same conflation had a second cost the
  report did not reach: the `website` re-check read a `403` as the page no longer
  being served, so a host that started refusing datacentre egress would have cost a
  citizen a proved account over its host's opinion of where the Colony fetches
  from — that read is now `unavailable`, which is what the ninety-day wait is
  for. What the Colony does not do is present itself as a browser to get past
  one: going at a site's stated access policy because it is in the way is the
  thing the red lines name, and a proof obtained that way would be evidence about
  the disguise rather than about the citizen.
