/**
 * The Colony's mark, on every console page (`#498`).
 *
 * A sponsor signs in, is asked to fund a quest with real money, and until this
 * existed the page carrying that request looked like an unstyled document from
 * nowhere. `#422` fixed the palette; this is the other half.
 *
 * ## Inlined here, not fetched from the site — and the CSP is what decides it
 *
 * `#498` offered two arrangements and asked that the choice be made explicitly
 * rather than settled by whichever was quicker to type.
 *
 * **Serving it from `kolonie.ai` would mean widening the CSP.**
 * `CONSOLE_HEADERS` is `default-src 'none'` with exactly one relaxation,
 * `img-src 'self'`, and `#397` narrowed even that on purpose: same origin only,
 * no data URI, nothing a stranger's text could point at. A cross-origin `<img>`
 * would need `img-src` to name another host **on the surface where a stranger
 * is asked for money**, permanently, for a decoration. That trade is wrong in
 * the direction that matters.
 *
 * Two smaller things fall the same way. The console would render a broken
 * image whenever the website is down, on the one page that must not look
 * improvised. And an inlined mark needs no request at all, on pages reached
 * from a mail client on a phone.
 *
 * ## What is copied, what is not, and what watches the copy
 *
 * **The geometry is copied. No colour is.** The strokes are `var(--k-accent)`
 * and `var(--k-text-strong)`, which `theme.ts` already carries and
 * `scripts/check-theme-drift.mjs` already compares against the website's
 * `theme.css`. So the mark's colour has exactly one source and it is not this
 * file — which is better than the position `#498` was worried about, and is
 * only possible because it is inlined.
 *
 * That leaves the path data, and a copy with nothing watching it is not a copy.
 * `scripts/check-mark-drift.mjs` reads `kolonie-website/public/mark.svg` and
 * fails when the paths or the stroke weight here stop matching it; the existing
 * `theme-drift.yml` runs it against the website's `main` daily, beside the
 * palette check it is modelled on.
 *
 * **The regular cut, untiled**, which is the same one the website's own header
 * uses. `kolonie-docs/brand/README.md` §2 is the rule: the tile exists for a
 * background the Colony does not control, and this one is `--k-bg`.
 */
export const CONSOLE_MARK = [
  '<svg viewBox="0 0 64 64" aria-hidden="true" focusable="false" class="console-mast__mark">',
  '<g fill="none" stroke-width="5" stroke-linejoin="miter" stroke-linecap="butt" stroke-miterlimit="6">',
  '<path d="M32 10 L51 15 C51 32 46 45.5 32 55 C18 45.5 13 32 13 15 Z" stroke="var(--k-accent)"/>',
  '<path d="M24.5 21 L31.5 28 L24.5 35" stroke="var(--k-accent)"/>',
  '<path d="M39.5 21 L39.5 35" stroke="var(--k-text-strong)"/>',
  '</g>',
  '</svg>',
].join('')

/**
 * The masthead: the mark, the name, and a way back to the site.
 *
 * **Above the navigation and not inside it**, because it is on every page and
 * the navigation is not. `CONSOLE_HEADER` renders only for somebody a session
 * authorises; the operator page reached from a mail link and the autonomy form
 * are read by people who have no account and have never heard of the Colony,
 * and they are the readers this issue is actually about.
 *
 * **It links out to `kolonie.ai`.** A stranger asked for money by a page they
 * arrived at from an email needs a way to find out who is asking, and there is
 * no other link on those pages that offers one. It is a plain `GET` to a public
 * page, so it costs nothing the CSP cares about, and `referrer-policy:
 * no-referrer` already means the site is not told which console page it came
 * from.
 *
 * Not `aria-hidden`: this link is the only place some of these pages name the
 * Colony at all, so the text is real and the SVG beside it is the decorative
 * half.
 */
export const CONSOLE_MAST = [
  '<a class="console-mast" href="https://kolonie.ai">',
  CONSOLE_MARK,
  '<span>Kolonie AI</span>',
  '</a>',
].join('')
