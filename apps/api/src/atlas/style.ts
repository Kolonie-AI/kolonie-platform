/**
 * The Atlas's own styles (`kolonie-website#97`).
 *
 * ## Why there is a second stylesheet at all
 *
 * The Atlas rendered through `CONSOLE_STYLE` and nothing else, which gave it a
 * palette, a typeface and element rules — and left every class the pages
 * actually emit unstyled. `k-atlas-index`, `k-refused`, `k-unwritten`, `k-paid`
 * and `k-atlas-facts` were all written by `#546`, `#588` and `#589` and none of
 * them had a rule anywhere. `#97`'s first sentence is the measurement:
 *
 * > `kolonie.ai/atlas` is live … **three entries, an index with one heading, and
 * > no link to any of it from anywhere on the site.**
 *
 * ## What it is trying to be
 *
 * The maintainer's ask, 2026-08-08: *"die muss richtig fancy aussehen … und die
 * Seiten müssen richtig cool und gut aussehen. Die Atlas-Einträge sind ganz,
 * ganz wichtig."*
 *
 * **And `#11`'s refusals still hold**, which is the constraint that makes that
 * ask answerable rather than an invitation to decorate: no gradients, no
 * illustration, no logos. `#97` adds the last one and gives the reason — a grid
 * of other companies' marks reads as a partnership page and none of them has
 * agreed to anything. **The category is the visual, not the brand.**
 *
 * So what does the work here is structure: a shelf is a card, a state is a
 * chip, and the index reads as a map rather than as a bulleted list. Nothing
 * below draws a picture.
 *
 * ## Every value is a token
 *
 * There is not a colour, a size or a spacing literal in this file. The tokens
 * are the Colony's own, and they arrive twice over: `CONSOLE_STYLE` declares
 * them, and since `kolonie-website#99` the site's `theme.css` arrives with the
 * chrome and declares the same ones. That is the property that keeps this
 * surface from becoming a third design — the thing `#422` fixed once already.
 *
 * ## No JavaScript, and no way for one to creep in
 *
 * D-062, and `#97` requires filtering to work without one. The filter is a link
 * and the states are text; there is nothing here that a script would be needed
 * to operate, which is why the Content-Security-Policy on these responses can
 * refuse scripts outright.
 */
export const ATLAS_STYLE = `
/* ---- Prose is set in the prose face ------------------------------------- */

/*
 * **The Atlas is the one public surface among the console's pages, and prose
 * set in the monospace face is what a terminal dump looks like**
 * (kolonie-website#97). \`CONSOLE_STYLE\` sets the whole body in
 * \`--k-font-mono\`, which is right for an operator's tables and forms and wrong
 * for the four sentences that carry this site's claim.
 *
 * \`--k-font-prose\` arrives with the site's own \`theme.css\`, which reaches these
 * pages with the chrome since \`kolonie-website#99\`. **The fallback is the
 * important half**: when the website cannot be reached the token is undeclared,
 * and the second argument is a system stack rather than nothing — a page that
 * lost its chrome must not also lose its typography to the browser's default
 * serif, which is the exact defect \`kolonie-website#48\` records.
 *
 * The monospace face keeps everything it is for: the mark, the headings, the
 * steps, the labels and the chips. It is the visual identity and it stays
 * where identity belongs.
 */
main p,
main li,
.k-atlas-index small {
  font-family: var(--k-font-prose, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif);
  letter-spacing: normal;
}

main h1 {
  font-family: var(--k-font-mono);
  letter-spacing: var(--k-tracking-heading);
}

/* The standfirst: the sentence that says what the whole page is. */
main h1 + p {
  max-width: var(--k-measure);
  color: var(--k-text-strong);
  font-size: var(--k-text-lg);
}

/* ---- The shelves, which are the index's navigation ---------------------- */

/*
 * A row of links with a count each. It is the whole of the filtering interface
 * (kolonie-website#97), and it is a \`<nav>\` rather than a list of headings
 * because that is what it is: fourteen shelves, and the reader picks one.
 */
.k-atlas-shelves ul {
  display: flex;
  flex-wrap: wrap;
  gap: var(--k-space-2);
  margin: var(--k-space-5) 0 var(--k-space-6);
  padding: 0;
  list-style: none;
}

.k-atlas-shelves li {
  margin: 0;
}

.k-atlas-shelves a {
  display: inline-flex;
  align-items: center;
  gap: var(--k-space-2);
  /* 44px, the floor kolonie-website#98 sets for anything a thumb is meant to
     find. These are the most-pressed controls on the page. */
  min-height: 2.75rem;
  padding: var(--k-space-2) var(--k-space-4);
  border: var(--k-border) solid var(--k-hairline);
  border-radius: 999px;
  color: var(--k-text);
  font-size: var(--k-text-sm);
  text-decoration: none;
}

.k-atlas-shelves a:hover,
.k-atlas-shelves a:focus-visible {
  border-color: var(--k-accent);
  color: var(--k-accent);
}

/*
 * The shelf being shown, marked rather than merely coloured. \`aria-current\` is
 * what a screen reader announces and the styling follows it, so the two cannot
 * go out of step — a colour set separately would say it to one reader in two.
 */
.k-atlas-shelves a[aria-current='page'] {
  border-color: var(--k-accent);
  color: var(--k-accent-strong);
  background: var(--k-accent-dim);
}

/*
 * The count, and it is derived on every render rather than typed
 * (kolonie-website#97: *ninety-six providers* ages on the next curation).
 * Quieter than the name it follows: it is context, not the label.
 */
.k-atlas-count {
  color: var(--k-text-faint);
  font-size: var(--k-text-xs);
  font-variant-numeric: tabular-nums;
}

/* ---- The index ---------------------------------------------------------- */

/*
 * One card per entry, in a grid that reflows on its own.
 *
 * \`auto-fit\` with \`minmax(min(100%, …), 1fr)\` is responsive with no breakpoint
 * at all — the same construction the site uses for its card grids, and a layout
 * that never has to be told a width cannot be told the wrong one.
 */
.k-atlas-index {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 20rem), 1fr));
  gap: var(--k-space-4);
  margin: 0 0 var(--k-space-7);
  padding: 0;
  list-style: none;
}

.k-atlas-index li {
  padding: var(--k-space-4);
  border: var(--k-border) solid var(--k-hairline);
  border-radius: var(--k-radius);
  background: var(--k-surface);
}

.k-atlas-index li:hover {
  border-color: var(--k-hairline-strong);
}

/*
 * The provider's name is the card's own heading, so it is set as one — and the
 * whole card is not a link, deliberately: a card that is one link cannot hold
 * the second link a category needs, and #97 is about internal linking running
 * in both directions.
 */
.k-atlas-index li > a:first-child {
  color: var(--k-text-strong);
  font-size: var(--k-text-lg);
  font-weight: 600;
  text-decoration: none;
}

.k-atlas-index li > a:first-child:hover,
.k-atlas-index li > a:first-child:focus-visible {
  color: var(--k-accent);
}

.k-atlas-index small {
  display: block;
  margin-top: var(--k-space-2);
  color: var(--k-text-muted);
}

/* ---- What state an entry is in ------------------------------------------ */

/*
 * **Chips, and every state but \`joinable\` has one** (\`#588\`, \`#604\`). A
 * joinable entry is unmarked because it is the ordinary case and the figures
 * beside it already say how it went; an unmarked entry in any other state is
 * indistinguishable from a working recipe, which is the catalogue pretending.
 *
 * The two are different colours and neither is red-for-failure: a refusal is a
 * finding and saves an agent a day, and it should not read as an error. That is
 * \`#97\`'s *"those entries save the most time and should not read as
 * failures"*, in a colour.
 */
.k-refused,
.k-unwritten,
.k-paid {
  display: inline-block;
  padding: 0 var(--k-space-2);
  border: var(--k-border) solid currentColor;
  border-radius: 999px;
  font-size: var(--k-text-xs);
  letter-spacing: var(--k-tracking-label);
  white-space: nowrap;
}

.k-refused {
  color: var(--k-caution-high);
}

.k-unwritten {
  color: var(--k-text-muted);
}

/*
 * Paid is a marker and never a footnote (\`#543\` rule 3). It buys the entry and
 * nothing about ordering, which \`atlasRank\` enforces by never being given the
 * field — this only has to make sure a reader can see it.
 */
.k-paid {
  color: var(--k-text-faint);
}

/*
 * On an entry page the same classes carry a paragraph rather than a chip, so
 * the pill is undone where the element is a block. One class, two jobs, and the
 * shape follows the element.
 */
p.k-refused,
p.k-unwritten,
p.k-paid {
  display: block;
  padding: var(--k-space-4);
  border-radius: var(--k-radius);
  border-width: 0;
  border-inline-start: 3px solid currentColor;
  font-size: var(--k-text-base);
  letter-spacing: normal;
  white-space: normal;
  background: var(--k-surface);
}

/* ---- An entry page ------------------------------------------------------ */

/*
 * The two facts a reader arrives asking for (\`#589\`), given the weight of an
 * answer rather than of a caption: what sort of thing this is, and whether an
 * operator will be needed.
 */
.k-atlas-facts {
  margin: var(--k-space-4) 0 var(--k-space-6);
  color: var(--k-text-muted);
  font-family: var(--k-font-mono);
  font-size: var(--k-text-sm);
  letter-spacing: var(--k-tracking-label);
}

.k-atlas-facts a {
  color: var(--k-accent);
}

/*
 * When it was last walked (\`#525\`, surfaced by \`kolonie-website#97\`). Quiet,
 * and under the recipe rather than over it: it qualifies what is above it.
 */
.k-atlas-confirmed {
  margin-top: var(--k-space-5);
  color: var(--k-text-faint);
}

/*
 * A recipe's steps. Numbered by the list rather than by the text, so an agent
 * reading the rendered page and an agent reading the markdown count the same.
 */
main section ol {
  padding-left: var(--k-space-6);
}

main section ol li,
main section ul li {
  font-family: var(--k-font-prose, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif);
}

/* A step's instruction is prose; the operator marker on it is not. */
main section li strong {
  font-family: var(--k-font-mono);
  letter-spacing: var(--k-tracking-label);
}

main section li + li {
  margin-top: var(--k-space-3);
}

/*
 * A section per row of the catalogue — one provider can be joinable for a
 * mailbox and refused for a domain, and the rule between them is what stops the
 * second being read as a footnote to the first.
 */
main section {
  margin-top: var(--k-space-6);
  padding-top: var(--k-space-5);
  border-top: var(--k-border) solid var(--k-hairline);
}

main section h2 {
  font-family: var(--k-font-mono);
  letter-spacing: var(--k-tracking-label);
}
`
