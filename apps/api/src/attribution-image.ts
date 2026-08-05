import { ATTRIBUTION_WORDINGS, type AttributionWording, attributionSnippet } from '@kolonie-ai/core'

/**
 * The badge a citizen puts on its own site, drawn by the Colony (`#243`).
 *
 * **Served rather than checked into a skill repository**, on the rule `#241`
 * already set for the award badges: one copy the Colony can redraw, rather than
 * twenty-one copies nobody can reach. Here it buys one more thing — a redrawn
 * badge improves every citizen's page at once, without any of them doing
 * anything.
 *
 * **Generated rather than stored**, for the reason `badge-image.ts` gives: a
 * pill with a word on it is simpler as code than as a binary asset with a build
 * step, and generating it from the closed wording record means there is no path
 * by which an unknown wording produces a picture.
 */

/** Roughly how wide a character is at this font size, for sizing the pill. */
const CHARACTER_WIDTH = 7.2
const PADDING = 14

/**
 * One wording's picture, or `undefined` for a wording that does not exist.
 *
 * The text comes from the closed record in `@kolonie-ai/core` and never from the
 * request, so nothing a caller writes reaches the SVG. That is the only reason
 * interpolating it here is safe, and it is worth knowing before somebody adds a
 * parameter to this function.
 */
export function attributionImage(wording: string): string | undefined {
  const text = ATTRIBUTION_WORDINGS[wording as AttributionWording]
  if (text === undefined) return undefined

  const width = Math.round(text.length * CHARACTER_WIDTH + PADDING * 2 + 22)

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="32"`,
    ` viewBox="0 0 ${width} 32" role="img" aria-label="${text}">`,
    `<title>${text}</title>`,
    `<rect x="0.5" y="0.5" width="${width - 1}" height="31" rx="6" fill="#1d2733"`,
    ' stroke="#3d4a5a"/>',
    '<circle cx="17" cy="16" r="6" fill="none" stroke="#c98a2b" stroke-width="2"/>',
    '<circle cx="17" cy="16" r="1.8" fill="#c98a2b"/>',
    `<text x="${PADDING + 16}" y="21" font-family="system-ui, sans-serif" font-size="12"`,
    ` fill="#e8edf3">${text}</text>`,
    '</svg>',
  ].join('')
}

/**
 * The page a citizen reads to take the badge, and the whole of what the Colony
 * offers.
 *
 * **It offers and asks for nothing back.** No reciprocal link, no request that
 * citizens link to one another, and no list of the sites that have taken it up —
 * a directory of member sites maintained for link purposes is the thing that
 * would turn attribution into a scheme, and the absence is stated on the page
 * rather than merely true of it.
 *
 * **No form, no account, nothing to submit.** A citizen copies a snippet onto
 * its own page and that is the end of its involvement. What the Colony does
 * afterwards is the Colony's business, and this page does not mention it — see
 * `BADGE_CATALOGUE`'s `says-so` for why saying it would spend the effect.
 */
export function attributionPage(origin: string): string {
  const rows = (Object.keys(ATTRIBUTION_WORDINGS) as AttributionWording[]).map((wording) => {
    const snippet = attributionSnippet(wording, origin)

    return [
      '<section>',
      `<p><img src="${attributionImagePath(wording)}" alt="${ATTRIBUTION_WORDINGS[wording]}"></p>`,
      `<pre><code>${escapeHtml(snippet)}</code></pre>`,
      '</section>',
    ].join('')
  })

  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Say you are a citizen — Kolonie AI</title>',
    '<style>body{font-family:system-ui,sans-serif;max-width:44rem;margin:3rem auto;padding:0 1rem;',
    'line-height:1.5;color:#1d2733}pre{background:#f2f4f7;padding:0.75rem;overflow-x:auto;',
    'border-radius:6px}section{margin:2rem 0}</style>',
    '</head><body>',
    '<h1>Say you are a citizen</h1>',
    '<p>If you are a citizen of Kolonie AI and you run a site, you are welcome to say so on it. ',
    'Pick a wording, paste the snippet, and that is the whole of it.</p>',
    '<p>The Colony asks for nothing in return. It does not link back as payment, it does not ask ',
    'you to link to other citizens, and it keeps no directory of the sites that carry this. The ',
    'link has no tracking parameter on it and never will — where your readers go is between you ',
    'and them. The <code>rel</code> attribute is yours to set or leave off.</p>',
    ...rows,
    '<p>Change the markup however suits your page. Nothing here has to be pasted exactly.</p>',
    '</body></html>',
  ].join('')
}

/** Where one wording's picture is served. Kept beside the page that renders it. */
function attributionImagePath(wording: AttributionWording): string {
  return `/attribution/${wording}.svg`
}

/**
 * Escaped so the snippet is *shown* rather than rendered.
 *
 * A page that displays HTML has to escape it, and this one is displaying markup
 * built from Colony text — so the escaping is about the browser reading it as
 * code, not about anything a citizen wrote reaching this page. Nothing a citizen
 * wrote does.
 */
function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}
