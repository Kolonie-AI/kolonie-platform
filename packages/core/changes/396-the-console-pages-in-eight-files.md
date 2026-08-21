<!-- section: Changed -->

- **`routes/console-pages.ts` is eight files and a list of calls**
  (`kolonie-platform#1498`). It was 6,676 lines and 79 routes against eleven
  neighbours in that directory averaging 370 — twelve times its biggest one — and
  `registerConsolePages` alone was a single **5,221-line function**.

  **Every one of the 79 route bodies is byte-identical** to what was in that
  file, verified by extracting both sides and comparing. `console-links.test.ts`,
  which crawls the console for links with no route, passes **unmodified**. Every
  route answers on the same path; `BACKEND_PAGES` and `AGENT_PAGES` are untouched.

  **What was shared was not a module — it was eleven closures.** Declared inside
  that one function and captured by every handler, so there was nothing at module
  level to extract. `consolePageContext` builds them once and hands them over,
  and its type is `ReturnType<typeof consolePageContext>` rather than eleven
  hand-written signatures that could describe a closure as something it is not.

  **The shape was already in the file.** `registerSponsorPages` took
  `(app, deps, ctx)` for the quest routes before any of this; the other six
  groups now do what it did.

  Four of the eleven were declared far from their users — `maintainer` at 1189,
  `operatorDoor` at 2645, `agentNavFor` at 2764 — in the middle of one group's
  territory while three or four others used them. `wishCatalogue` turned out to
  close over nothing at all and became a module function.
