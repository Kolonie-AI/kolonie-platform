<!-- section: Fixed -->

- **A catalogue-floor raise is judged against the text the squash will land**
  (`kolonie-platform#1379`). The merge queue rewrites the commit message to the
  pull request title and body, so a justified branch commit with an unjustified
  body was green on the branch and red on `main` for everybody — it happened once
  (`2a4cf08b`) and cost a repair commit.

  `check:catalogue-floor` now reads that text inside the **required** CI job, on
  a pull request and on a queue entry alike, so an unjustified body cannot land
  even while `Report the change` is not itself required. Locally, with no such
  text to read, a raise whose last touching commit is not yet on `origin/main`
  is allowed and warned: the next run in CI is what fails it.

- **A committed conflict marker stops CI being created at all**
  (`kolonie-platform#1379`). One reached `.github/workflows/ci.yml` on a branch,
  and nothing downstream noticed: the workflow simply had no triggers, so no run
  was made and the pull request rendered as _waiting for a check_. `format:check`
  does not parse YAML and the text assertions matched the surviving halves.
  `scripts/workflows-parse.test.ts` now refuses `git`'s four markers in any
  workflow file, and checks each one still declares when it runs.
