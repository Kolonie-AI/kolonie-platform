<!-- section: Fixed -->

- Every test file in `packages/db` ran twice, and both runs were green. A
  project under `extends: true` inherits `include` by having it _merged_ onto its
  own rather than replaced, so the root-level `src/**/*.test.ts` was concatenated
  onto the isolation project's single entry and that project collected all 188
  files: 375 file runs instead of 188, and the package — already the long pole of
  every `npm test` — paying twice for it. The glob is now stated on the one
  project it belongs to and nowhere above it. A doubled run is not a failing
  test, so it is asserted rather than watched: every workspace's collection is
  compared against the test files on disk, which catches a file collected twice
  and a file collected by nobody with the same assertion, and follows the
  isolation list in both directions instead of hard-coding a count.
