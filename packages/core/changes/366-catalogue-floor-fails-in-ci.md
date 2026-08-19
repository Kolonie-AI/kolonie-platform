<!-- section: Fixed -->

- **The catalogue-floor ratchet can fail in CI** (`kolonie-platform#1373`).
  `#1118` shipped a runner that exits zero when it cannot read git history, which
  is right for an export and was the whole of every CI run: `actions/checkout`
  defaults to depth 1, so the guard never saw a previous floor. The `build` job
  now fetches full history, and the same runner fails closed under
  `GITHUB_ACTIONS` if the clone is still shallow — so putting the silent pass
  back is a red check, not a quiet one.
