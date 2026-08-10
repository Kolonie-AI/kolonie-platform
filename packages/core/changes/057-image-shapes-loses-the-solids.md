<!-- section: Changed -->

- **`IMAGE_SHAPES` loses the solids.** `cube`, `sphere` and `pyramid` are trivial
  for a generator and a shading problem for a rasterizer, so a rung that
  certifies drawing must not ask for them. New: `IMAGE_SHAPES_RETIRED` and
  `IMAGE_SHAPES_EVER`.

  **A retired shape stays readable.** `ImageConstraintsSchema` parses against
  `IMAGE_SHAPES_EVER` while `drawImageConstraints` picks only from
  `IMAGE_SHAPES` — so nothing new is minted with a solid and no specification
  already issued becomes unreadable at verification.
