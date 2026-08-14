/**
 * The console's theme, in the Colony's own tokens (`#422`).
 *
 * Until this file existed the entire stylesheet for every page an operator or a
 * sponsor sees was nine rules and **not one colour** — everything the browser's
 * default, on the browser's default background. So an operator followed a link
 * out of a mail, arrived at the surface on which they decide whether to keep
 * paying for their agent, and it did not look like the same project as the site
 * they were sent from.
 *
 * ## One palette, and the drift check is the thing that keeps it one
 *
 * The values in {@link CONSOLE_TOKENS} are `kolonie-website`'s, from
 * `src/styles/theme.css`, and they are copied rather than imported because the
 * two live in different repositories and the console has no build step to import
 * through. A copy needs a check or it is two palettes with a shared history:
 * `scripts/check-theme-drift.mjs` reads the website's `theme.css` and fails when
 * a value here no longer matches it, and `.github/workflows/theme-drift.yml`
 * runs it against the website's `main`. Same shape as the website's own font
 * copies, which `theme.test.ts` asserts still match the npm package byte for
 * byte.
 *
 * ## Dark only
 *
 * `kolonie-website#30` decided dark for `/`, and the same reasoning applies to a
 * page reached from a mail client: the light half here was `color-scheme: light
 * dark` and one set of browser defaults, which is to say two appearances nobody
 * had ever looked at. The light values in the website's theme are deliberately
 * **not** copied.
 *
 * ## What is deliberately not taken
 *
 * **The typeface.** The website self-hosts JetBrains Mono; the console's CSP is
 * `default-src 'none'` and that strictness is worth more than the face on a page
 * reached from an email. `--k-font-mono` is declared below with the same name
 * and a system stack, and the drift check knows to skip it.
 *
 * **JavaScript, still none.** Everything here is CSS.
 */

/**
 * The tokens that must be the website's, exactly.
 *
 * Only the dark values, and only what a page here can use: the ground, the
 * surfaces, the hairlines, the text ramp, the amber accent, the five semantic
 * colours, and the scale and spacing steps the tiles are built on. Anything
 * added here is something `check-theme-drift.mjs` will start comparing, which is
 * the intended way to grow it.
 */
export const CONSOLE_TOKENS: Readonly<Record<string, string>> = {
  /* One nearly-neutral ramp at a single hue. */
  '--k-bg': 'hsl(200 14% 7%)',
  '--k-surface': 'hsl(200 13% 11%)',
  '--k-surface-raised': 'hsl(200 12% 16%)',
  '--k-hairline': 'hsl(200 11% 19%)',
  '--k-hairline-strong': 'hsl(200 10% 41%)',

  '--k-text-strong': 'hsl(200 9% 95%)',
  '--k-text': 'hsl(200 8% 84%)',
  '--k-text-muted': 'hsl(200 8% 68%)',
  '--k-text-faint': 'hsl(200 8% 55%)',

  '--k-accent': 'hsl(36 92% 60%)',
  '--k-accent-strong': 'hsl(36 95% 80%)',
  '--k-accent-dim': 'hsl(36 55% 14%)',
  '--k-on-accent': 'var(--k-bg)',

  /* The five that mean something rather than decorate. The console uses `good`
   * for a rung that was cleared, `caution` for one that was attempted and did
   * not get through, and `danger` for a refusal; the other two are here so the
   * set is the website's set rather than a subset somebody has to extend under
   * time pressure. */
  '--k-note-dim': 'hsl(205 45% 14%)',
  '--k-note': 'hsl(205 65% 60%)',
  '--k-note-high': 'hsl(205 70% 82%)',
  '--k-tip-dim': 'hsl(275 32% 17%)',
  '--k-tip': 'hsl(275 50% 68%)',
  '--k-tip-high': 'hsl(275 55% 85%)',
  '--k-caution-dim': 'hsl(30 45% 14%)',
  '--k-caution': 'hsl(30 80% 60%)',
  '--k-caution-high': 'hsl(30 85% 80%)',
  '--k-danger-dim': 'hsl(355 40% 17%)',
  '--k-danger': 'hsl(355 70% 65%)',
  '--k-danger-high': 'hsl(355 80% 85%)',
  '--k-good-dim': 'hsl(150 40% 12%)',
  '--k-good': 'hsl(150 55% 52%)',
  '--k-good-high': 'hsl(150 55% 80%)',

  /* Type. One scale, and every size on a page here is a step on it. */
  '--k-text-xs': '0.75rem',
  '--k-text-sm': '0.875rem',
  '--k-text-base': '1rem',
  '--k-text-lg': '1.125rem',
  '--k-text-xl': '1.35rem',
  '--k-text-2xl': '1.6rem',
  '--k-text-3xl': '2rem',
  '--k-text-4xl': '2.5rem',

  '--k-tracking-heading': '-0.015em',
  '--k-tracking-label': '0.06em',

  '--k-measure': '68ch',

  /**
   * **The composition width, and it is a different thing from `--k-measure`**
   * (`#584`, taking `kolonie-website#81`'s decision rather than making a second
   * one).
   *
   * `--k-measure` caps a *line of prose* so the eye does not lose its place.
   * This caps the *composition* — the masthead's row, each section of a page,
   * the footer — so that at a width nobody designed for the page is something
   * arranged on a field rather than a row stretched across one.
   *
   * **The same 80rem the site uses.** Measured 2026-08-08: the console rendered
   * at `46rem` (736px) against `kolonie.ai`'s `80rem` (1280px), so somebody
   * moving from the site to the console landed on a page a little over half as
   * wide, on the same screen, in the same session. The console never received
   * `#81` because it has its own stylesheet in its own repository — the cost of
   * the split (D-062), not an argument against it.
   *
   * **Tables and forms take this width and not the prose one.** They are most of
   * what an operator is here for, and capping the queue, the wish list and the
   * quests table at a paragraph's width was never a decision anybody made — it
   * was one number doing two jobs.
   */
  '--k-container': '80rem',

  /* Spacing, on a 4px step, and the vertical rhythm above it. */
  '--k-space-1': '0.25rem',
  '--k-space-2': '0.5rem',
  '--k-space-3': '0.75rem',
  '--k-space-4': '1rem',
  '--k-space-5': '1.5rem',
  '--k-space-6': '2rem',
  '--k-space-7': '3rem',

  '--k-radius': '0.375rem',
  '--k-border': '1px',
}

/**
 * The console's own tokens, which are **not** the website's and are not
 * compared with it.
 *
 * `--k-font-mono` carries the same name deliberately: a page here should be
 * styled against the same token a page there is, and what differs is only which
 * faces are reachable. Naming it something else would mean every rule below
 * chose between two font tokens, which is how a stylesheet ends up with both.
 */
const LOCAL_TOKENS: Readonly<Record<string, string>> = {
  '--k-font-mono':
    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
  /**
   * The smallest tap target a finger reliably hits (`#608`).
   *
   * 44px is Apple's figure and the one WCAG 2.5.8 rounds to. Measured on
   * `kolonie.ai` at 390px on 2026-08-08, most controls there are under 40 —
   * this is here so the console does not reproduce that, and it is a token so
   * that the next control added is not a new judgement call.
   */
  '--k-tap': '44px',
}

function declarations(tokens: Readonly<Record<string, string>>): string {
  return Object.entries(tokens)
    .map(([name, value]) => `    ${name}: ${value};`)
    .join('\n')
}

/**
 * The whole stylesheet, inline, because there is no second file to serve.
 *
 * A static asset route would be one more thing to cache, to version and to get
 * wrong; the console's CSS is still shorter than the code that would serve it.
 *
 * **Every colour below is a `var(--k-*)`.** `theme.test.ts` fails on a literal,
 * which is the same rule the website enforces from the other side — a value in a
 * page is a value the palette does not know about.
 */
export const CONSOLE_STYLE = `
  :root {
${declarations(CONSOLE_TOKENS)}

${declarations(LOCAL_TOKENS)}

    /* Dark, and only dark — the reasoning is at the top of theme.ts. */
    color-scheme: dark;
  }

  body {
    font: var(--k-text-base)/1.6 var(--k-font-mono);
    color: var(--k-text);
    background: var(--k-bg);
    margin: 0 auto;
    max-width: var(--k-container);
    padding: var(--k-space-6) var(--k-space-4) var(--k-space-7);
  }

  h1, h2, h3 {
    color: var(--k-text-strong);
    letter-spacing: var(--k-tracking-heading);
    font-weight: 600;
    line-height: 1.2;
  }

  h1 { font-size: var(--k-text-2xl); margin: 0 0 var(--k-space-5); }
  h2 {
    font-size: var(--k-text-xl);
    margin: var(--k-space-7) 0 var(--k-space-3);
    padding-top: var(--k-space-4);
    border-top: var(--k-border) solid var(--k-hairline);
  }
  h3 { font-size: var(--k-text-lg); margin: var(--k-space-5) 0 var(--k-space-2); }

  p { margin: 0 0 var(--k-space-4); max-width: var(--k-measure); }

  /* Running text, wherever it is not a paragraph. An unclassed list in the
     console is prose with bullets on it, and it reads at a paragraph's width for
     the same reason a paragraph does. A list that carries a class is a component
     and sizes itself. */
  ul:not([class]), ol:not([class]) { max-width: var(--k-measure); }

  a { color: var(--k-accent); text-underline-offset: 0.2em; }
  a:hover { color: var(--k-accent-strong); }

  strong { color: var(--k-text-strong); }

  code {
    background: var(--k-surface-raised);
    border-radius: var(--k-radius);
    padding: 0.1em 0.35em;
    word-break: break-all;
  }

  table {
    border-collapse: collapse;
    width: 100%;
    margin: 0 0 var(--k-space-4);
    background: var(--k-surface);
    border-radius: var(--k-radius);
    overflow: hidden;
  }
  th, td {
    border-bottom: var(--k-border) solid var(--k-hairline);
    padding: var(--k-space-3);
    text-align: left;
    vertical-align: top;
  }
  th { color: var(--k-text-muted); font-weight: 400; }
  tr:last-child th, tr:last-child td { border-bottom: 0; }

  label { display: block; color: var(--k-text-muted); margin-bottom: var(--k-space-1); }

  input, textarea {
    font: inherit;
    color: var(--k-text-strong);
    background: var(--k-surface);
    border: var(--k-border) solid var(--k-hairline-strong);
    border-radius: var(--k-radius);
    padding: var(--k-space-2) var(--k-space-3);
    width: 100%;
    /* **Full width of the form, not of the composition** (#584). A table wants
       the whole 80rem and gets it; a text field that is 1280px long is not a
       better text field, and the cursor ends up somewhere the eye is not. This
       is the one place the prose measure is doing a layout job rather than a
       reading one, and it is doing it deliberately. */
    max-width: var(--k-measure);
    box-sizing: border-box;
  }
  input[type="radio"] { width: auto; accent-color: var(--k-accent); }
  input:focus-visible, textarea:focus-visible, button:focus-visible {
    outline: 2px solid var(--k-accent);
    outline-offset: 2px;
  }

  button {
    font: inherit;
    font-weight: 600;
    color: var(--k-on-accent);
    background: var(--k-accent);
    border: var(--k-border) solid var(--k-accent);
    border-radius: var(--k-radius);
    padding: var(--k-space-2) var(--k-space-5);
    margin-top: var(--k-space-3);
    cursor: pointer;
  }
  button:hover { background: var(--k-accent-strong); border-color: var(--k-accent-strong); }

  .operator-asks { list-style: none; padding: 0; }
  .operator-ask {
    padding: var(--k-space-3);
    background: var(--k-surface);
    border-left: var(--k-space-1) solid var(--k-accent);
  }
  .operator-answer-controls {
    display: flex;
    align-items: flex-start;
    flex-wrap: wrap;
    gap: var(--k-space-3);
  }
  .operator-answer-controls button { margin-top: 0; }
  .operator-answer-explanation { flex: 1 1 28rem; }
  .operator-answer-explanation textarea { display: block; }
  .operator-answer-explanation button { margin-top: var(--k-space-2); }
  details.operator-context {
    margin-top: var(--k-space-4);
    border-top: var(--k-border) solid var(--k-hairline);
    padding-top: var(--k-space-3);
  }
  details.operator-context > summary {
    color: var(--k-text-strong);
    font-size: var(--k-text-lg);
    font-weight: 600;
    cursor: pointer;
  }

  /* A link that starts a redirect, dressed as the button it is doing the job of
     (#425). It is an anchor and not a form so that a GET hands the browser to
     the provider — which is what leaves form-action 'self' and the absence of
     JavaScript both intact. */
  a.button {
    display: inline-block;
    font-weight: 600;
    color: var(--k-on-accent);
    background: var(--k-accent);
    border: var(--k-border) solid var(--k-accent);
    border-radius: var(--k-radius);
    padding: var(--k-space-2) var(--k-space-5);
    text-decoration: none;
  }
  a.button:hover {
    color: var(--k-on-accent);
    background: var(--k-accent-strong);
    border-color: var(--k-accent-strong);
  }

  /* The mark, on every page (#498). Above the navigation rather than in it,
     because the pages read by somebody with no session — the operator page and
     the autonomy form — are the ones this was opened for.

     The SVG is sized in em so it tracks the name beside it, and the strokes
     are var(--k-*): the geometry is a copy of the website's and the colour is
     not a copy at all. See console/mark.ts. */
  .console-mast {
    display: inline-flex;
    align-items: center;
    gap: var(--k-space-2);
    margin-bottom: var(--k-space-5);
    color: var(--k-text-strong);
    font-size: var(--k-text-lg);
    font-weight: 600;
    letter-spacing: var(--k-tracking-label);
    text-decoration: none;
  }
  .console-mast:hover { color: var(--k-text-strong); }
  .console-mast__mark { display: block; width: 1.55em; height: 1.55em; }

  /* The console's navigation (#608), replacing #431's row of links.

     One column on a phone with the navigation above the content, two from 60rem
     up with it beside. Same markup and the same document order in both — the
     narrow case is not a drawer, because a drawer that slides needs a script or
     the checkbox hack, and D-062 rules out the first while the second traps
     focus and lies to a screen reader about what it is.

     min-width: 0 on the content is load-bearing: a grid item's default is
     auto, so one wide table would push the whole layout past the viewport and
     produce the horizontal scrollbar this design exists to avoid. */
  /* The mark and the sign-out on one row, above everything (#608). The
     sign-out is here rather than in the navigation because one inside a
     collapsible section is one people cannot find. */
  .console-topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--k-space-4);
    flex-wrap: wrap;
  }
  .console-topbar .console-mast { margin-bottom: 0; }
  .console-topbar form { margin: 0; }
  .console-topbar button {
    margin-top: 0;
    min-height: var(--k-tap);
    padding: var(--k-space-1) var(--k-space-4);
    font-weight: 400;
    color: var(--k-text-muted);
    background: none;
    border-color: var(--k-hairline-strong);
  }
  .console-topbar button:hover {
    color: var(--k-text-strong);
    background: var(--k-surface-raised);
    border-color: var(--k-hairline-strong);
  }

  .console-shell {
    display: grid;
    grid-template-columns: 1fr;
    gap: var(--k-space-5);
    align-items: start;
    margin-top: var(--k-space-5);
  }
  /* min-width: 0 is load-bearing and not enough on its own. A grid item's
     default width is auto, so one wide table pushes the layout past the
     viewport — that part min-width fixes. What it does not fix is the table
     itself being wider than the column it now sits in, and at 390px the
     console has several: a Solana address is 44 characters with nowhere to
     break.

     So the content scrolls inside its own column and the page does not. This
     was measured rather than reasoned about: at 390px with a wide table,
     document.scrollWidth exceeded clientWidth until this line existed. */
  .console-main {
    min-width: 0;
    overflow-x: auto;
  }

  @media (min-width: 60rem) {
    .console-shell {
      grid-template-columns: 15rem minmax(0, 1fr);
      gap: var(--k-space-7);
    }
    /* Beside the content and staying there while it scrolls. The navigation is
       short enough that this needs no scroll container of its own; if it ever
       is not, the fix is overflow on this element and not a shorter list. */
    .console-nav { position: sticky; top: var(--k-space-4); }
  }

  .console-nav {
    font-size: var(--k-text-sm);
    padding-bottom: var(--k-space-4);
    border-bottom: var(--k-border) solid var(--k-hairline);
  }
  @media (min-width: 60rem) {
    .console-nav { padding-bottom: 0; border-bottom: 0; }
  }

  /* <details>/<summary> is the disclosure: native, keyboard operable, and it
     still works with no stylesheet at all. */
  .console-nav details { border-bottom: var(--k-border) solid var(--k-hairline); }
  .console-nav details:last-of-type { border-bottom: 0; }
  .console-nav summary {
    display: flex;
    align-items: center;
    min-height: var(--k-tap);
    cursor: pointer;
    color: var(--k-text-muted);
    letter-spacing: var(--k-tracking-label);
    text-transform: uppercase;
    font-size: var(--k-text-xs);
  }
  /* The disclosure marker, drawn rather than inherited. display: flex on the
     summary suppresses the browser's own triangle, and a closed section with no
     affordance reads as a heading nobody can open — which is worse than the row
     of links this replaced. Looked at in a browser at 390px, which is where it
     was noticed. */
  .console-nav summary::-webkit-details-marker { display: none; }
  .console-nav summary::after {
    content: "▸";
    margin-left: auto;
    color: var(--k-text-faint);
  }
  .console-nav details[open] > summary::after { content: "▾"; }
  .console-nav summary:hover { color: var(--k-text-strong); }
  .console-nav summary:focus-visible {
    outline: 2px solid var(--k-accent);
    outline-offset: 2px;
  }

  .console-nav ul {
    list-style: none;
    margin: 0 0 var(--k-space-2);
    padding: 0;
  }
  .console-nav li a {
    display: flex;
    align-items: center;
    /* The tap target, and the reason it is a min-height rather than padding: a
       two-line label on a narrow screen has to grow past 44px, not be clipped
       to it. */
    min-height: var(--k-tap);
    padding: 0 var(--k-space-3);
    color: var(--k-text-muted);
    text-decoration: none;
    border-left: 2px solid transparent;
  }
  .console-nav li a:hover {
    color: var(--k-text-strong);
    background: var(--k-surface);
  }

  /* Where you are, styled off aria-current rather than off a class — the
     attribute is what tells a screen reader, and hanging the appearance on the
     same thing means the two cannot disagree. */
  .console-nav li a[aria-current="page"] {
    color: var(--k-text-strong);
    border-left-color: var(--k-accent);
    background: var(--k-surface);
  }

  /* A page of this agent's with nothing on it yet (#797, keeping #583's rule).
     Marked in the markup and only coloured here, so a reader with no stylesheet
     gets the same fact — which is the point of writing it as text.

     The contents column this replaces lived here until #797. It was displayed
     only from 75rem, so the one reader it was built for — somebody scrolling a
     long page on a phone — never saw it. The sections are pages now, and the
     column that navigates them is the console's own, which is shown at every
     width because it is a details element rather than a second grid track. */
  .console-nav__empty { color: var(--k-text-faint); margin-left: var(--k-space-1); }

  /* The overview on the agent page (#798): one line per section, saying what is
     there. It is content rather than navigation, and it is shown at every width.

     Comments in here are served to the browser inside the page, so keep them
     clear of the words a page test asserts are absent: a note written here once
     matched an assertion about what the page does not carry.

     No grid and no columns: the title and the sentence wrap as one line so a
     narrow screen breaks them where the words allow, and eight lines still fit
     one screen at a desktop width, which is the point of the page. */
  .page-overview { list-style: none; margin: 0 0 var(--k-space-6); padding: 0; }
  .page-overview li {
    padding: var(--k-space-2) 0;
    border-bottom: var(--k-border) solid var(--k-hairline);
    font-size: var(--k-text-sm);
  }
  .page-overview li a { color: var(--k-text-strong); }
  .page-overview__said { color: var(--k-text-muted); }

  .note { color: var(--k-text-faint); font-size: var(--k-text-sm); }
  .note strong { color: var(--k-text-muted); }

  /* The agent's name in blocks (#424). Sized against the viewport rather than
     in rem: the block is 69 columns at its widest and has to fit a phone held in
     one hand as well as a desktop window, and the one failure the fallback
     exists to prevent is a horizontal scrollbar in a mail client's browser. */
  pre.wordmark {
    color: var(--k-accent);
    font-size: min(0.8rem, 2.2vw);
    line-height: 1.05;
    margin: 0 0 var(--k-space-4);
    overflow: hidden;
  }

  /* The operator's four numbers (#423). A number in a table cell is a record;
     the same number set large is an achievement, and grid is the whole of it —
     four tiles on a desktop, two on a phone, no JavaScript anywhere. */
  ul.tiles {
    list-style: none;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
    gap: var(--k-space-3);
    padding: 0;
    margin: 0 0 var(--k-space-5);
  }
  ul.tiles .tile {
    background: var(--k-surface);
    border: var(--k-border) solid var(--k-hairline);
    border-radius: var(--k-radius);
    padding: var(--k-space-4);
  }
  ul.tiles .figure {
    display: block;
    font-size: var(--k-text-4xl);
    line-height: 1.1;
    color: var(--k-accent);
    letter-spacing: var(--k-tracking-heading);
  }
  ul.tiles .label {
    display: block;
    margin-top: var(--k-space-1);
    color: var(--k-text-muted);
    font-size: var(--k-text-sm);
  }

  /* Last awake, citizen since, accounts held: facts rather than achievements,
     so they are set as prose and not as tiles. */
  .standing-dates {
    display: flex;
    flex-wrap: wrap;
    gap: var(--k-space-2) var(--k-space-5);
    margin-bottom: var(--k-space-5);
  }
  .standing-dates .label {
    color: var(--k-text-faint);
    font-size: var(--k-text-sm);
    letter-spacing: var(--k-tracking-label);
    text-transform: uppercase;
  }

  /* The rungs, as a line going somewhere rather than as rows (#423). The rule
     down the left is what makes it read as one trajectory. */
  ol.trajectory {
    list-style: none;
    padding: 0 0 0 var(--k-space-4);
    margin: 0 0 var(--k-space-4);
    border-left: 2px solid var(--k-hairline);
  }
  ol.trajectory li {
    display: flex;
    gap: var(--k-space-4);
    padding: var(--k-space-2) 0;
  }
  ol.trajectory .when {
    flex: 0 0 8.5rem;
    color: var(--k-text-faint);
    font-size: var(--k-text-sm);
  }
  ol.trajectory .against {
    display: block;
    color: var(--k-text-faint);
    font-size: var(--k-text-sm);
  }
  /* The newest step, which is the one an operator is looking for: the question
     is whether it is still getting anywhere, not how long the list is. */
  ol.trajectory .latest {
    background: var(--k-good-dim);
    border-radius: var(--k-radius);
    margin-left: calc(-1 * var(--k-space-3));
    padding: var(--k-space-2) var(--k-space-3);
  }
  ol.trajectory .latest strong { color: var(--k-good-high); }

  /* The pulse of recent attempts (#432), under the tiles: the verdict is
     a chip on the right, and a failure is coloured as an unfinished thing rather
     than as a red mark — a task reopens once the citizen has said what stopped
     it, so "not yet" is literally true. */
  ul.attempts {
    list-style: none;
    padding: 0;
    margin: 0 0 var(--k-space-4);
  }
  ul.attempts li {
    display: flex;
    align-items: baseline;
    gap: var(--k-space-4);
    padding: var(--k-space-2) 0;
    border-bottom: var(--k-border) solid var(--k-hairline);
  }
  ul.attempts li:last-child { border-bottom: 0; }
  ul.attempts .when { flex: 0 0 8.5rem; color: var(--k-text-faint); font-size: var(--k-text-sm); }
  ul.attempts .what { flex: 1 1 auto; }
  ul.attempts .verdict {
    flex: 0 0 auto;
    border-radius: 999px;
    padding: 0 var(--k-space-3);
    font-size: var(--k-text-xs);
    letter-spacing: var(--k-tracking-label);
    text-transform: uppercase;
  }
  .attempt-passed .verdict { background: var(--k-good-dim); color: var(--k-good-high); }
  .attempt-reported .verdict { background: var(--k-note-dim); color: var(--k-note-high); }
  .attempt-not-yet .verdict { background: var(--k-caution-dim); color: var(--k-caution-high); }

  /* Badges as chips (#423). #241 made them deliberately worthless and therefore
     deliberately playful; a bulleted list is the one rendering that files them. */
  ul.badges {
    list-style: none;
    display: flex;
    flex-wrap: wrap;
    gap: var(--k-space-3);
    padding: 0;
    margin: 0 0 var(--k-space-4);
  }
  ul.badges li {
    display: flex;
    align-items: center;
    gap: var(--k-space-2);
    background: var(--k-surface-raised);
    border: var(--k-border) solid var(--k-hairline);
    border-radius: 999px;
    padding: var(--k-space-1) var(--k-space-4) var(--k-space-1) var(--k-space-1);
  }
  ul.badges li img { width: 2rem; height: 2rem; }
  ul.badges li strong { font-size: var(--k-text-sm); }
  ul.badges li span { color: var(--k-text-faint); font-size: var(--k-text-xs); }
`
