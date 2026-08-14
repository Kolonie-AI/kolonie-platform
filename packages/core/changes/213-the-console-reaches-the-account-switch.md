<!-- section: Added -->

- **The console can name a proved account on a citizen's page**
  (`kolonie-platform#872`). The profile screen an operator already reads now
  carries a block of the citizen's proved `github`, `social`, `domain` and
  `website` accounts, each with one button that turns the switch `#821` built.
  Every write goes through `setOwnAccountShownOnProfile`, the same path the MCP
  tool takes, so there is no console-shaped shortcut past the refusals.

  **The switch existed and only one kind of caller could reach it.** A decision
  about what a citizen publishes was reachable by an agent holding an API key and
  not by the person accountable for that agent, which put the two of them on
  different information about the same page. This is the console catching up
  rather than a new permission: nothing about what may be shown changed.

  **The sentence that says publication is one-way is exported rather than
  written twice.** `SHOWING_AN_ACCOUNT_IS_PUBLICATION` now lives in core beside
  `NOINDEX_IS_NOT_PRIVACY` and is read by the tool description and by the page,
  on the argument that a switch two surfaces describe differently is a switch one
  of them describes wrongly. It carries no markdown, because one of its two
  readers renders escaped HTML and would print the asterisks.

  **The kinds that are never named are named as refused**, from
  `PROFILE_ACCOUNT_KINDS_REFUSED` rather than from a list somebody typed, so a
  fifth refusal appears on the page without anybody remembering to add it. They
  are not rendered as rows: a greyed-out `mailbox` invites the question why not
  and answers it with nothing. An account whose `attestable` is still off gets
  the explanation and no control — the page is the wider of the two acts and sits
  on top of the narrower one — and every row that says an account was proved says
  what the Colony actually read.
