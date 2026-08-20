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
 * The lede a person reads before deciding whether the rest is for them
 * (\`kolonie-website#122\`). Set like \`.k-atlas-description\` on an entry page,
 * for the same reason: it is the first sentence and the only one that answers
 * *what am I looking at*. The standfirst that follows keeps body weight, so the
 * two read as a lede and its detail rather than as two competing openings —
 * which is what a second paragraph at the same size would have been.
 */
.k-atlas-lede {
  margin: var(--k-space-4) 0 var(--k-space-4);
  font-size: var(--k-text-lg);
  line-height: 1.5;
}

.k-atlas-lede a {
  color: var(--k-accent);
}

/*
 * The box a reader types a provider name into (\`#1302\`).
 *
 * Wraps rather than scrolls: a search that pushed its own button off a phone
 * would be a search a phone cannot submit. The label is visible rather than
 * hidden behind a placeholder, because a placeholder disappears the moment
 * somebody starts typing and is the one word saying what the field is for.
 */
.k-atlas-search {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--k-space-2);
  margin: var(--k-space-4) 0;
}

.k-atlas-search label {
  color: var(--k-text-faint);
  font-size: var(--k-text-xs);
}

.k-atlas-search input {
  flex: 1 1 14rem;
  /* 44px, the floor kolonie-website#98 sets for anything a thumb finds. */
  min-height: 2.75rem;
  min-width: 0;
  padding: var(--k-space-2);
  border: var(--k-border) solid var(--k-hairline);
  border-radius: var(--k-radius);
  background: var(--k-surface);
  color: var(--k-text);
  font: inherit;
}

.k-atlas-search button {
  min-height: 2.75rem;
  padding: var(--k-space-2) var(--k-space-4);
  border: var(--k-border) solid var(--k-hairline);
  border-radius: var(--k-radius);
  background: var(--k-surface);
  color: var(--k-text);
  font: inherit;
  cursor: pointer;
}

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

/*
 * The rest of a capped shelf (\`#1142\`).
 *
 * A card in the same grid, so it lands directly after the six rows rather than a
 * whole gap below them — the \`ul\` above carries the shelf's bottom margin.
 *
 * **Dashed and unfilled**, because it is a direction and not an entry: the rule
 * that sets a provider's name is overridden here so that a reader scanning the
 * shelf does not read \`All 27\` as the twenty-seventh provider.
 */
.k-atlas-index li.k-atlas-all {
  display: flex;
  align-items: center;
  justify-content: center;
  border-style: dashed;
  background: none;
}

.k-atlas-index li.k-atlas-all > a:first-child {
  font-size: var(--k-text-base);
  font-weight: 500;
  color: var(--k-accent);
  text-decoration: none;
}

.k-atlas-index li.k-atlas-all > a:first-child:hover,
.k-atlas-index li.k-atlas-all > a:first-child:focus-visible {
  text-decoration: underline;
}

/*
 * The way to the rest of a shelf that did not fit on one page (\`#1143\`).
 *
 * **A row of three with the position in the middle**, and the two links pushed to
 * the ends by the gap: on the first page there is no *Previous*, and the space
 * where it would be stays empty rather than sliding *Next* across — a control
 * that moves between pages is one a reader has to find again each time.
 */
.k-atlas-pages {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--k-space-4);
  margin-top: var(--k-space-6);
  font-size: var(--k-text-sm);
}

.k-atlas-pages span {
  margin-inline: auto;
  color: var(--k-text-muted);
}

.k-atlas-pages a {
  color: var(--k-accent);
  text-decoration: none;
}

.k-atlas-pages a:hover,
.k-atlas-pages a:focus-visible {
  text-decoration: underline;
}

/*
 * What the provider is, on the row (\`#1121\` decision 6).
 *
 * **Clamped here and whole in the markup.** The sentence goes into the document
 * complete, for a crawler and for anybody reading the source; the layout stays a
 * list because this rule ends the line, not because the renderer cut it. Cutting
 * it in HTML would have taken it away from both readers to satisfy one.
 */
.k-atlas-said {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
.k-partly,
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

/*
 * **A third colour, because \`partly\` is a third thing** (\`#1163\`). A row where
 * somebody got in and the route is still refused is neither the caution the
 * refusal wears nor the grey of *nobody has looked*: it is a finding with
 * something usable in it, and reusing either chip would put it back in the state
 * whose headline the issue was about.
 */
.k-partly {
  color: var(--k-note-high);
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

/* ---- The marks beside them ---------------------------------------------- */

/*
 * **One rule for seven icons** (\`#1332\`). Every mark is drawn at \`1em\` with
 * \`stroke="currentColor"\` and no fill, so it takes the colour of the chip it is
 * inside and nothing here has to know which chip that is. What this adds is the
 * two things a viewBox cannot: the optical alignment against the text baseline,
 * and the gap.
 *
 * \`vertical-align: -0.125em\` rather than \`middle\`: at this size \`middle\` sits a
 * mark visibly high against lower-case text, and the number is the usual
 * cap-height correction rather than a taste.
 *
 * **No hover, no transition, no state.** These are decoration beside a word that
 * already says the thing (\`#1326\` decision 7), so there is nothing for them to
 * respond to — and a page with no script cannot have anything anyway.
 */
.k-icon {
  vertical-align: -0.125em;
  margin-inline-end: var(--k-space-1);
  flex: none;
}

/*
 * **The earn and dual-use chips wear the chip shape of their neighbours**
 * (\`#1332\`, \`#1326\` decision 7), because a reader scanning a header should not
 * have to learn that two different kinds of pill mean two different kinds of
 * fact. What separates them is the colour and the mark, not the geometry.
 *
 * The note colour rather than a new one: \`#1326\` decision 7 refuses a palette of
 * its own, and \`--k-note\` is what \`.k-partly\` already uses for *there is
 * something usable here*, which is what an earn facet says.
 */
.k-atlas-earn,
.k-atlas-dual {
  display: inline-block;
  padding: 0 var(--k-space-2);
  border: var(--k-border) solid currentColor;
  border-radius: 999px;
  font-size: var(--k-text-xs);
  letter-spacing: var(--k-tracking-label);
  white-space: nowrap;
  color: var(--k-note-high);
}

/*
 * Both axes at once is the stronger claim of the two, so it takes the accent
 * rather than the note — the one place on an Atlas page where the Colony's own
 * colour marks a fact about a provider rather than a link.
 */
.k-atlas-dual {
  color: var(--k-accent-strong);
}

/*
 * **A wall list drops its bullets, because the mark is the bullet** (\`#1332\`).
 * Keeping both would put two glyphs in front of every line for no second fact,
 * and the mark is the one that says what kind of line this is.
 *
 * The caution colour, matching \`.k-refused\`: a wall is the same class of finding
 * as a refusal, one row further down.
 */
.k-atlas-walls {
  list-style: none;
  padding-inline-start: 0;
}

.k-atlas-wall .k-icon {
  color: var(--k-caution-high);
}

/*
 * The homepage line is identity and not a chip, so the mark sits inline in a
 * paragraph and takes the muted colour the label around it already has.
 */
.k-homepage .k-icon {
  color: var(--k-text-muted);
}

/*
 * On an entry page the same classes carry a paragraph rather than a chip, so
 * the pill is undone where the element is a block. One class, two jobs, and the
 * shape follows the element.
 */
p.k-refused,
p.k-partly,
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

/*
 * The three facts a row carries besides its state (\`#1164\`): who is needed,
 * what the provider charges to sign up, and which way it was measured.
 *
 * **Quieter than the state chips above, deliberately.** Those answer whether an
 * entry is worth opening at all; these three qualify an entry the reader has
 * already decided is a candidate, and giving them the same weight would turn a
 * fifty-row shelf into a wall of pills with nothing standing out. No border, a
 * surface behind them, and the muted text colour.
 *
 * **A row prints only the ones it has.** The renderer omits an unasked cost and
 * a kind with no direction to it rather than printing a placeholder, so there is
 * no empty state to style here — a row with one chip is the ordinary case.
 */
.k-atlas-need,
.k-atlas-cost,
.k-atlas-way {
  display: inline-block;
  padding: 0 var(--k-space-2);
  border-radius: var(--k-radius);
  background: var(--k-surface);
  color: var(--k-text-muted);
  white-space: nowrap;
}

/* ---- An entry page ------------------------------------------------------ */

/*
 * What the provider is, under the heading and above everything (\`#1121\`
 * decision 4). Larger than body text because it is the first sentence on the
 * page and the only one that answers *what am I looking at*; unclamped, because
 * a page has the room a list row does not.
 */
.k-atlas-description {
  margin: var(--k-space-4) 0 var(--k-space-5);
  font-size: var(--k-text-lg);
  line-height: 1.5;
}

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
 * The chips past the sixth (\`#1404\` decision 4). Quieter than the line it
 * follows, because it is the overflow and not a second header — and it takes
 * the margin the line above it gives up, so a header with a disclosure and one
 * without occupy the same space until the disclosure is opened.
 */
.k-atlas-facts-rest {
  margin: calc(var(--k-space-4) * -1) 0 var(--k-space-6);
  color: var(--k-text-faint);
  font-family: var(--k-font-mono);
  font-size: var(--k-text-sm);
}

.k-atlas-facts-rest summary {
  cursor: pointer;
}

.k-atlas-facts-rest .k-atlas-facts {
  margin: var(--k-space-3) 0 0;
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

/*
 * The criteria box (\`#1105\`). Scanned rather than read: the question is the
 * quiet label and the answer is what carries the weight, which is the inverse of
 * how a definition list renders untouched.
 *
 * It degrades to a legible question-then-answer sequence with no CSS at all —
 * these pages are served with no stylesheet a reader can rely on, so the markup
 * has to be right before this rule is applied rather than because of it.
 */
.k-atlas-criteria {
  margin: var(--k-space-5) 0;
  padding: var(--k-space-4) var(--k-space-5);
  border: var(--k-border) solid var(--k-hairline);
}

.k-atlas-criteria dt {
  color: var(--k-text-muted);
  font-family: var(--k-font-mono);
  font-size: var(--k-text-sm);
  letter-spacing: var(--k-tracking-label);
}

.k-atlas-criteria dd {
  margin: 0 0 var(--k-space-4);
}

.k-atlas-criteria dd:last-child {
  margin-bottom: 0;
}

/* What citizenship buys, directly under the box it is the missing half of. */
.k-atlas-citizen {
  color: var(--k-text-muted);
}

/*
 * The block saying what a Colony account buys (\`kolonie-website#111\`).
 *
 * Marked off rather than made loud: it is an aside on a page of findings, and a
 * banner would be the catalogue selling. The rule on the left is the whole of the
 * emphasis, so with no stylesheet at all it is still a heading and two
 * paragraphs in the place the markup puts them.
 */
.k-atlas-colony {
  margin: var(--k-space-5) 0;
  padding: var(--k-space-2) 0 var(--k-space-2) var(--k-space-4);
  border-left: var(--k-border) solid var(--k-hairline);
}

.k-atlas-colony h2 {
  margin-top: 0;
}

.k-atlas-colony p:last-child {
  margin-bottom: 0;
}

/* The two next steps, one per reader, held together as one block. */
.k-atlas-cta {
  color: var(--k-text);
}

/*
 * The links out of the bottom of a provider page (\`kolonie-website#113\`).
 *
 * Set off with the same rule as the block above, on the other side: it closes
 * the page as that one opens it. The list keeps its markers — it is a list of
 * places to go and reads as one with no stylesheet at all.
 */
.k-atlas-next {
  margin: var(--k-space-5) 0 0;
  padding: var(--k-space-2) 0 var(--k-space-2) var(--k-space-4);
  border-left: var(--k-border) solid var(--k-hairline);
}

.k-atlas-next h2 {
  margin-top: 0;
}

.k-atlas-next ul {
  margin: 0 0 var(--k-space-2);
  padding-left: var(--k-space-4);
}
`
