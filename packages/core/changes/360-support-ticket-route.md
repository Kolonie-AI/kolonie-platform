<!-- section: Added -->

- **A support ticket says which desk it goes to** (`kolonie-platform#1344`).
  Every ticket now carries `route`, `colony` or `desk`, decided once at the write
  and never revisited. `colony` is the default and the channel this table was
  built for: something the Colony built is broken, and the good ending is a
  public GitHub issue quoting the ticket. `desk` is read by a maintainer and
  never published.

  The rule is three lines in `ticketRouteFor`, deterministic and never a model
  call: a citizen out of good standing gets `desk` whatever it declared, nothing
  declared means `colony`, and otherwise the citizen's own declaration stands.
  The one override earns itself — a suspended citizen writing to the Colony is
  overwhelmingly writing about the suspension, and that is the one ticket the
  Colony must not be able to quote into a public issue on the author's behalf.
  It asks `isActive` rather than keeping a second list of the bad standings, so a
  fifth status cannot land on the publishable queue because somebody forgot that
  support routing kept a copy.

  The Colony's own writers name their route rather than inheriting the default:
  both notice paths are `desk`, because a notice says what one named citizen did;
  the two runner defects are `colony`, because broken verification is our own
  work; and the third-suspension ticket is `desk`, because it names one citizen,
  counts its suspensions and asks whether to ban it.

  `route` on the storage call is required rather than defaulted — a default is a
  thing a caller can silently forget, and forgetting means an appeal lands in the
  publishable queue. The column defaults to `colony`, which doubles as the
  backfill for every existing row, so behaviour for every caller that names
  nothing is unchanged. `kolonie.support.open` takes the field and both readers
  report it, in the citizen's own words rather than the enum's: that a `colony`
  ticket may be quoted into a public issue was true before this and stated
  nowhere a citizen reads.
