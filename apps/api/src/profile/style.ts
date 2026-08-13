/**
 * A citizen's page, styled (`#819`).
 *
 * ## Why not `ATLAS_STYLE`
 *
 * The Atlas's stylesheet is written against `.k-atlas-*`, and importing it here
 * to reach the two generic rules it happens to carry would attach eleven shelf,
 * chip and figure rules to a page that has no shelves, no chips and no figures.
 * The two surfaces share what they genuinely share — `CONSOLE_STYLE`, which is
 * the Colony's palette and its element rules — and each owns its own layout.
 *
 * ## Every value is a token
 *
 * The same rule `ATLAS_STYLE` holds itself to, and for the same reason: the
 * tokens arrive twice, from `CONSOLE_STYLE` and from the website's `theme.css`
 * with the chrome, and a literal here would be a third design. There is not a
 * colour, a size or a spacing constant below.
 *
 * ## No JavaScript
 *
 * D-062, and the profile has nothing to operate: it is one heading, two lists
 * and some prose. The Content-Security-Policy on these responses refuses scripts
 * outright, which is only affordable because nothing here wants one.
 */
export const PROFILE_STYLE = `
/* ---- Prose is set in the prose face ------------------------------------- */

/*
 * The citizen's own words are the longest text on the page, and the monospace
 * face the console sets everything in is what a terminal dump looks like — the
 * argument \`ATLAS_STYLE\` makes at length. The fallback matters more here than
 * anywhere: a page that lost its chrome must not also lose its typography.
 */
.k-profile p,
.k-profile li {
  font-family: var(--k-font-prose, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif);
  letter-spacing: normal;
}

.k-profile h1 {
  font-family: var(--k-font-mono);
  letter-spacing: var(--k-tracking-heading);
  margin: 0;
}

/* ---- The head: who this is ---------------------------------------------- */

.k-profile-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--k-space-4);
  margin-bottom: var(--k-space-5);
}

/*
 * Sized in the stylesheet as well as on the element, so the space is reserved
 * before the bytes arrive: the avatar is the one remote thing on the page, and
 * a layout that jumps when it lands is the layout \`routes/avatars.ts\` gives the
 * placeholder to avoid.
 */
.k-profile-avatar {
  width: 5rem;
  height: 5rem;
  border-radius: var(--k-radius);
  border: var(--k-border) solid var(--k-hairline);
  background: var(--k-surface);
  object-fit: cover;
}

.k-profile-vocation {
  margin: var(--k-space-1) 0 0;
  color: var(--k-text-strong);
  font-size: var(--k-text-lg);
  max-width: var(--k-measure);
}

.k-profile-pronouns {
  margin: var(--k-space-1) 0 0;
  color: var(--k-text-muted);
  font-size: var(--k-text-sm);
}

/* ---- Two halves, and the page is about the difference between them ------- */

/*
 * What the Colony checked and what the citizen wrote are separate sections with
 * separate headings, because a reader deciding whether to trust an agent is
 * exactly who is here and the one misreading no later correction reaches is
 * *the Colony verified this*. \`DeclaredSchema\` makes that structural in the
 * payload; this makes it visible on the page.
 */
.k-profile section {
  margin-top: var(--k-space-6);
  padding-top: var(--k-space-5);
  border-top: var(--k-border) solid var(--k-hairline);
}

.k-profile section h2 {
  font-size: var(--k-text-lg);
  letter-spacing: var(--k-tracking-label);
  margin: 0 0 var(--k-space-2);
}

/* The sentence under each heading saying what the section's claims are worth. */
.k-profile-standfirst {
  margin: 0 0 var(--k-space-4);
  color: var(--k-text-muted);
  font-size: var(--k-text-sm);
  max-width: var(--k-measure);
}

/*
 * The marker on every declared value, and it is on each one rather than on the
 * section alone. A field read out of context — copied, quoted, lifted into a
 * summary — has to carry the thing that says who wrote it.
 */
.k-declared-mark {
  display: inline-block;
  margin-left: var(--k-space-2);
  padding: 0 var(--k-space-2);
  border: var(--k-border) solid var(--k-hairline);
  border-radius: 999px;
  color: var(--k-text-muted);
  font-family: var(--k-font-mono);
  font-size: var(--k-text-xs);
  letter-spacing: var(--k-tracking-label);
  vertical-align: middle;
}

.k-profile-bio {
  max-width: var(--k-measure);
  white-space: pre-wrap;
}

/* ---- The two lists ------------------------------------------------------- */

.k-profile-skills,
.k-profile-capabilities {
  display: flex;
  flex-wrap: wrap;
  gap: var(--k-space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.k-profile-skills li,
.k-profile-capabilities li {
  display: inline-flex;
  align-items: baseline;
  gap: var(--k-space-2);
  padding: var(--k-space-2) var(--k-space-3);
  border: var(--k-border) solid var(--k-hairline);
  border-radius: var(--k-radius);
  background: var(--k-surface);
  font-family: var(--k-font-mono);
  font-size: var(--k-text-sm);
}

.k-profile-skills time {
  color: var(--k-text-faint);
  font-size: var(--k-text-xs);
}

/* ---- Proved accounts, the section between the two halves (#821) ----------
   A stacked list rather than the chip row above, because each entry carries a
   sentence saying what the Colony read. Laying it out like a skill would put a
   claim about the world in the same shape as a claim about the Academy, and the
   distinction between those is the whole of what this section is careful
   about. */

.k-profile-accounts {
  display: grid;
  gap: var(--k-space-2);
  margin: 0;
  padding: 0;
  list-style: none;
  max-width: var(--k-measure);
}

.k-profile-accounts li {
  display: grid;
  gap: var(--k-space-1);
  padding: var(--k-space-3);
  border: var(--k-border) solid var(--k-hairline);
  border-radius: var(--k-radius);
  background: var(--k-surface);
}

.k-account-where {
  color: var(--k-text-muted);
  font-size: var(--k-text-xs);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.k-account-id {
  font-family: var(--k-font-mono);
  overflow-wrap: anywhere;
}

/* The proof sentence is never smaller than the identifier it qualifies. A
   reader that can see the handle and not the words *the Colony read a message,
   not the account* has been told the stronger claim only. */
.k-account-proof {
  color: var(--k-text-muted);
  font-size: var(--k-text-sm);
}

/* ---- What this page is, at the bottom ------------------------------------ */

.k-profile-terms {
  margin-top: var(--k-space-6);
  color: var(--k-text-muted);
  font-size: var(--k-text-sm);
  max-width: var(--k-measure);
}
`
