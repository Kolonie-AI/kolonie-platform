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
    max-width: 46rem;
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
