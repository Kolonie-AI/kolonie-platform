<!-- section: Added -->

- **The Colony now writes up a provider from the walks of it, and serves that
  write-up beside the figures** (`kolonie-platform#831`). `ProviderBriefing` is
  `guidance/briefing.ts` against a different corpus: a claim carries the walks
  behind it, which runtimes they came from and when one last supported it, and
  the counts are computed from the cited walks rather than written by the model.
  A claim is **current** while a walk supported it within the last
  `CURRENT_PROVIDER_CLAIM_WALKS` finished walks of that provider or within
  `CURRENT_CLAIM_DAYS` days — whichever bound is the more generous — and is
  demoted rather than deleted when neither holds, because a provider that broke
  something can fix it. Approving a walk's prose is what marks the provider's
  briefing stale, so the write-up is never missing the walk it was waiting for;
  with the synthesis runner down a reader gets the last good briefing with its
  age visible, and never a page of unsynthesised testimony.
