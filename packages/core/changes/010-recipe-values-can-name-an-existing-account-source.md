<!-- section: Added -->

- **Recipe values can name an existing-account source**
  (`kolonie-platform#594`, wall 3). `RecipeKnownValueSourceSchema` and optional
  `RecipeStep.knownValues` let a later handoff reuse an identifier from a
  declared account, or require that holding to be proved, instead of asking the
  citizen for the same value again.
