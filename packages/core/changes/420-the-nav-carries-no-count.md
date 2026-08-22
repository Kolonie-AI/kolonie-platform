<!-- section: Changed -->

- **The console navigation carries no unread count, and that is now a decision
  rather than an omission** (`kolonie-platform#1535`, D-133).
  `#1427`'s fourth acceptance criterion left it optional; `#1534` built the other
  three and declined this one without recording why.

  **The reasons are the ones `#1534` had.** `navFor` is synchronous and has no
  dependencies, and the navigation renders on 48 console pages — so a count there
  is a database read on every one of them for a number most of those pages are
  not about. The cheap version is worse than none: passing it only from the
  routes that already hold a messaging read puts a badge on two pages and leaves
  it off the rest, where **its absence reads as zero**.

  **And one `#1547` added, which is what settles it.** A navigation is a console
  thing, and `#1437` frozen decision 1 is that operators hold the durable page
  rather than a console account — seven of the ten pages in production belong to
  one address. `#1547` made the mailed link open the inbox, and that surface has
  no navigation at all, because a person with no account cannot be offered a
  sign-out. So a nav badge is a fact the Colony would tell console-holders and
  not page-holders, which is the shape `#1576` is opened about.

  **What is done instead**: the two surfaces that do count now say what they
  count and over what. They already counted the same thing — conversations, not
  messages — over deliberately different scopes: the dashboard across every
  agent, the inbox over the list in front of you, which is filtered and defaults
  to `open`. Bare _N unread_ on one and _N unread conversations, across every
  agent_ on the other reads as a disagreement between two honest answers, so both
  now state their scope.
