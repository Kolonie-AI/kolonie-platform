<!-- section: Fixed -->

- **`check:searchable` reads the working tree, not only what is tracked**
  (`kolonie-platform#1644`). One flag on one `git ls-files` call:
  `--others --exclude-standard`.

  **The gate was silent for exactly as long as a file was new**, which is the
  whole time it is being written and the case a NUL byte actually arrives in —
  nobody pastes one into a file they have been editing for a week.
  `apps/api/src/atlas/figures-cache.ts` was written with a raw NUL in a template
  literal, passed `npm run check` locally before `git add`, and failed the same
  commit on the runner. Same verdict, one push and six minutes apart.

  **The ignore rules are what kept `node_modules` and `dist` out**, and they
  still do — that exclusion is now stated by `.gitignore` rather than implied by
  a file not having been added yet. Five tests assert which files the gate reads,
  in both directions: an unadded file is checked, an ignored one is not, and a
  `.png` full of NULs is still the file working correctly.

  The three sibling gates the issue asked about do not share the blind spot.
  `check:fixtures` and `check:decisions` walk a directory, and
  `check:union-guards` reads the literal paths out of `.gitattributes` — none of
  them enumerates by `git ls-files`.
