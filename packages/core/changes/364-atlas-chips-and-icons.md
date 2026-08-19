<!-- section: Added -->

- **Seven marks on the Atlas, and a chip language that is the same on a shelf and
  on a page** (`kolonie-platform#1332`). Status, walls, earn facets and the
  homepage now carry an inline SVG mark beside their existing label — measured,
  joinable, refused, wall, earn, dual-use, homepage — so a reader scanning a
  header or a shelf of forty can see the shape of an entry before reading it.

  **Never icon-only**, which is the whole accessibility rule (`#1326`
  decision 7): every mark is `aria-hidden` and `focusable="false"` beside a word
  that already says the thing, and nothing in `icons.ts` takes a title or a label
  argument — the API makes the correct use the only use.

  **Inline SVG, because Atlas pages carry no script.** An icon font needs a font
  file, an `<img>` needs a request per glyph and cannot take `currentColor`, and
  a sprite sheet needs a second document. Every path is `stroke="currentColor"`
  with no fill, so a mark inside `.k-refused` is the caution colour and the same
  mark inside `.k-atlas-earn` is the note colour, with nothing in the icon module
  knowing either — which is what keeps the palette in `theme.ts` and stops a mark
  disagreeing with the word beside it.

  The earn and dual-use chips wear the geometry their neighbours already have, so
  a reader does not have to learn that two shapes of pill mean two kinds of fact;
  what separates them is the colour and the mark. A wall list drops its bullets,
  because the mark is the bullet.
