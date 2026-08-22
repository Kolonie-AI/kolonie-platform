<!-- section: Changed -->

- **The Atlas icons come from Font Awesome Free rather than being drawn here**
  (`kolonie-platform#1409`, `D-135`). `#1332` shipped seven marks drawn by hand;
  `#1409` asked for a decision between that and a self-hosted library, and the
  library wins — for a reason the issue did not lead with.

  **On bytes the drawn set was excellent.** Measured on the live Atlas index on
  2026-08-22: thirty-seven occurrences of seven distinct marks cost **612 bytes
  gzipped**, because gzip collapses a repeated string to almost nothing.

  What it actually cost is that **every icon after the seventh has to be
  invented** — a shape argued about, drawn at 16 px, and reviewed by people who
  are not designers. Font Awesome has two thousand already. Adding the ninth is
  now a line in `scripts/build-atlas-icons.mjs`.

  **The delivery does not change and that is the point.** Only the `d`
  attributes are taken, generated into `apps/api/src/atlas/icons.ts` at build
  time. No webfont, no stylesheet, no CDN, no runtime loader — so `font-src`
  stays closed and the CSP is untouched, which is the half of `#1332`'s argument
  worth keeping. The package is a devDependency.

  **What it costs, said plainly.** Font Awesome draws in far more detail than the
  crude marks did, and detail is what a path costs: over the same thirty-seven
  occurrences, **325 bytes gzipped becomes 1,400** — about five per cent of a
  twenty-kilobyte page. That is the price of not drawing icons.

  A ninth mark arrives with the change: `question`, on a heading the conditions
  box never had. It was a bare `<dl>` between two headed sections, which the
  no-stylesheet argument for a definition list works against — with no CSS the
  rows run straight on from whatever preceded them.

  `npm run check:atlas-icons` compares the generated file to what the subset
  would produce, beside `check:decisions` in `gates:tree`. Attribution for
  CC BY 4.0 is in `NOTICE`.
