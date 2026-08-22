## D-135 — The Atlas icon set comes from a library, not from us

**Date:** 2026-08-22

`#1409` asked for one icon system and offered two: a self-hosted Font Awesome
subset, or a token SVG sprite drawn in this repository. **The library wins, and
the reason is not the one the issue expected.**

## What was measured, and why it did not decide

`#1332` had already shipped the second option — seven marks drawn by hand in
`apps/api/src/atlas/icons.ts`, argued for on the grounds that an icon font needs
a font file and a sprite needs a second document. The measurement, on the live
Atlas index on 2026-08-22:

|              | with icons |  without |      cost |
| ------------ | ---------: | -------: | --------: |
| uncompressed |   88,487 B | 77,956 B |  10,531 B |
| **gzipped**  |   19,986 B | 19,374 B | **612 B** |

Thirty-seven occurrences of seven distinct marks cost **612 bytes on the wire**,
because gzip collapses a repeated string to almost nothing. On bytes the drawn
set was not merely acceptable, it was excellent, and a Font Awesome webfont
subset would have been several kilobytes and an extra request.

**So the byte argument was answered and it was the wrong argument.** What the
drawn set costs is that every icon after the seventh has to be invented — a shape
argued about, drawn at 16 px, and reviewed by people who are not designers. That
cost is paid by every future page, it does not appear in any measurement, and it
is the reason the operator asked for Font Awesome in the first place.

## What it costs, said plainly

The swap is **not** free, and the direction is the opposite of what the first
measurement suggests. Font Awesome's paths are drawn in much more detail than the
crude marks `#1332` made, and detail is what a path costs. Measured over the same
thirty-seven occurrences on the same page:

|                        | drawn by hand | Font Awesome |       change |
| ---------------------- | ------------: | -----------: | -----------: |
| average per occurrence |         285 B |        515 B |        +81 % |
| uncompressed, all 37   |      10,531 B |     19,256 B |     +8,725 B |
| **gzipped, all 37**    |     **325 B** |  **1,400 B** | **+1,075 B** |

A little over a kilobyte on a twenty-kilobyte page — about five per cent. That is
the price of not drawing icons, it is paid on every Atlas page, and it is worth
it. It is written here because a decision that records only the numbers
supporting it is not a record.

## What was decided

**The icons come from Font Awesome Free. The delivery does not change.**

`scripts/build-atlas-icons.mjs` reads a named subset out of the package and
generates `apps/api/src/atlas/icons.ts`. Only the `d` attributes are taken: no
webfont, no stylesheet, no CDN, no runtime loader. The package is a
**devDependency** — a source of shapes at build time, and nothing at runtime
depends on it.

That keeps every property `#1332` was right about:

- **`font-src` stays closed.** The CSP is unchanged, which is the concern
  `#1409` asked to have documented.
- **`currentColor`.** Font Awesome ships `fill="currentColor"`, so a mark inside
  `.k-refused` is still the caution colour with nothing in the icon knowing it.
- **No script.** Atlas pages carry none and still carry none.
- **Never icon-only** — `#1326` decision 7 — every mark stays `aria-hidden` and
  `focusable="false"`, and the API still takes no label argument.

And it removes the one that was costing us: **adding the ninth icon is adding a
line to a list.**

## Two things this reverses

`#1326` decision 7 refuses "an illustration framework" by name, and `#1332`
argued for drawing rather than importing. Both are overruled here, narrowly: what
is imported is path data at build time, which is neither a framework nor a
runtime dependency. The prohibition those decisions were really making — no
third-party request from a served page — is intact and is now asserted by a test.

## The alternative, and why not

**The webfont subset**, which is what `#1409` literally proposed. It needs
`pyftsubset` or an equivalent in the build, a `font-src` in the CSP, and a
request that blocks the icon paint — for a set measured at 612 bytes inline.
Moving to it later would change delivery and not a single icon name, because the
subset list is the interface. That is the reason to generate rather than paste.

## What holds it honest

`npm run check:atlas-icons` compares the generated file to what the subset would
produce, in `gates:tree` beside `check:decisions`. The file is committed rather
than gitignored — a reader should see the path data without installing anything —
and Prettier-ignored, because a `d` attribute is one token of several hundred
characters and formatting it is a disagreement with the generator.

Attribution is required by CC BY 4.0 and is in `NOTICE` and in the generated
file.
