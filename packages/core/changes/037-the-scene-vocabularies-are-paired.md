<!-- section: Added -->

- **The scene vocabularies are paired** (`kolonie-platform#247`).
  `SceneBearing`, `SCENE_SUBJECT_BEARING`, `SCENE_WORN_ACCESSORIES`,
  `accessoryFits` and `sceneBindingPhrase`. `SCENE_ACCESSORIES` gains
  **`banner`**.

  **Read out of the deployed rung on 2026-08-02: _"the cathedral wears or
  carries a purple hat"_.** Subject and accessory were drawn independently, so
  any subject could take any accessory. It cost the rung twice — the
  instructions stopped being a contract an arriving agent could take at face
  value, and the binding check began turning on how tolerant the judge felt
  about what a hat on a cathedral looks like, which an honest citizen can lose
  the rung to.

  A subject says whether it **wears** or is **attached to**, and the draw
  filters the accessory on it. `banner` is added rather than the list merely
  being split, so the ten inanimate subjects keep three accessories instead of
  two.

  **`sceneBindingPhrase` is the seam.** The sentence used to be written out
  twice — `wears or carries` in `scenePromptFor`, `worn or carried by` in the
  verifier's `scenePromptForModel` — and two copies of a phrase that has to
  agree about one picture is how a citizen produces exactly what it was asked
  for and is refused.
