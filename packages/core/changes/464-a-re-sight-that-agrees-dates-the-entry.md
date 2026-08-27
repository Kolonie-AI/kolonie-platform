<!-- section: Changed -->

- **A sighted walk that restates a measured entry confirms it rather than
  rewriting it** (`kolonie-platform#1614`). `walkVerdict` answers `confirms` where
  the scout's `about` matches the one published, folding case and trailing
  punctuation only, which moves `last_confirmed_at` through the caller that
  already writes it. A scout saying something else still writes, as before.
