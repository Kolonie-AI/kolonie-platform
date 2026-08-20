<!-- section: Fixed -->

- **The earn browse no longer says _Providers that pays_**
  (`kolonie-platform#1396`). The phrase map held whole third-person singular
  clauses — `pays for finished tasks` — which is right on a chip beside one
  provider and wrong under a plural heading. Measured on the live page after
  `#1365`: the title read _Providers that pays for finished tasks_, and the count
  read _5 providers match that pays for finished tasks_, which is two fragments
  joined by a variable rather than a sentence anybody wrote.

  The predicate is what is stored now — `for finished tasks`, `a referral` — and
  each caller supplies the verb its subject needs: `atlasEarnPhrase` for one
  provider, `atlasEarnPhrasePlural` for several. Storing both full forms would
  have put the wording in two places, and two places drift the first time a facet
  is reworded; the test asserts over all five that the two differ by exactly the
  verb, so a sixth cannot be added in one form only.

  The count sentence has its own shape rather than a conjugated stem: a reader
  who asked only for a facet did not _match_ anything, so it reads **`5 providers
pay for finished tasks.`**, and where a text query was asked too the two halves
  are joined — **`1 provider matches boards and pays for finished tasks.`**

  Chips on provider pages are unchanged.
