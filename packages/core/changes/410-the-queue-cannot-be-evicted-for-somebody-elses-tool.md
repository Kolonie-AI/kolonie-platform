<!-- section: Fixed -->

- **A required check can no longer evict a queued pull request for tools it did
  not add** (`kolonie-platform#1567`). `#1561` removes a database column and its
  diff under `apps/api/src/mcp/` is empty. It was evicted from the merge queue
  **four times in ninety minutes**, every time on _the catalogue grew by 2 tools_
  — two tools added by pull requests that had already merged. It could not have
  caused it and could not have fixed it.

  **Position A**, which is what the issue recommends: the check gates a pull
  request and reports in a merge group. The operative reason is not the one the
  issue gives, though, and it is worth stating because it changes what would
  count as a fix: a merge group serves `main` **plus every entry ahead of you**,
  so the difference against any committed figure is what several changes added
  together, and no verdict about _this_ entry can be drawn from it. The
  justification is not the missing piece — `#1545`'s action already fetches the
  pull request's text in a merge group — and freshening the floor (`#1566`) only
  narrows the window rather than closing it.

  What position B would catch is what a _combination_ of entries serves, which is
  the one thing only a merge group can see. Nobody has claimed that is what this
  check is for, and it would need a per-entry base the queue does not hand out.

  **Two smaller things came with it.** A refusal no longer tells a caller to write
  something _in this pull request_ when the run has none — `undefined` and `''`
  are now different answers, being _no pull request readable here_ and _there is
  one and it says nothing_. And where the check can still fail for a reason
  outside the change under test — a floor trailing `main` — it says so and how to
  tell, instead of asserting the one thing it cannot know.
