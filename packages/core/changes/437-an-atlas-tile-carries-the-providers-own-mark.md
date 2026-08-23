<!-- section: Added -->

- **An Atlas tile carries the provider's own mark** (`kolonie-platform#1405`),
  fetched once from that provider's homepage, checked, stored by the Colony and
  served from `kolonie.ai`. **The point is that the `<img>` is not the
  provider's URL.** `#823` made this argument about avatars and it is sharper at
  four hundred providers: an image element pointing at a provider's host would
  announce every reader of that provider's page to that provider — address,
  user-agent, the fact that somebody is researching them — from a page the Colony
  serves and puts its name on. So `ATLAS_HEADERS` keeps `img-src 'self'` exactly
  as it was: **this loosens no policy and adds no third-party origin**, which is
  the form `#1405` decision 4 takes once the bytes are on this side.
  `atlas_provider_icons` holds them, `/atlas/icon/<provider>` serves them, and a
  sweep on the verifier-runner's existing tick fills the table.
- **A provider with no icon gets a monogram, so a tile can never render a broken
  image.** Two letters from the host on a coloured square, drawn from the
  provider name and nothing else, inlined into the page rather than fetched —
  which is also why a shelf of forty tiles issues a handful of image requests
  rather than forty. Three different facts about the Colony's schedule (never
  looked, looked and found nothing, has bytes but the reader has not asked yet)
  render as the same picture, deliberately: what a reader sees is not a report on
  the sweep. `routes/avatars.ts` took the same decision about the citizen
  placeholder and for the same reason — a page that sometimes has an image
  element and sometimes does not is a page whose layout moves.
- **`sanitiseAvatar` decides what may be stored, and reusing it is the decision
  rather than the convenience.** It reads the magic number and the container
  structure instead of trusting a `type=` attribute, drops every ancillary block,
  and refuses SVG outright with the sentence this surface would otherwise have
  had to invent: _it can carry scripts and external references, and the Colony
  will not serve those from its own domain._ Its 16-pixel floor lands in exactly
  the right place here without being told about it — sixteen is the smallest real
  favicon anybody ships, and it is also the shape of a tracking pixel dressed as
  one.
- **`.k-atlas-index li > a:first-child` became `:first-of-type`.** The mark sits
  before the provider's name, so the name stopped being the first _child_ while
  remaining the first _link_. Under the old selector every heading on every tile
  would have silently lost its size, weight and colour and rendered as body text
  — nothing would have failed, and the catalogue would have looked wrong
  everywhere at once.
