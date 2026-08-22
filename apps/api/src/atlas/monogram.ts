/**
 * A provider's own mark, and the two letters that stand in for it (`#1409`,
 * `#1405`).
 *
 * ## Why a monogram at all
 *
 * Most providers have no icon the Colony can reach. Measured 2026-08-22 on the
 * live shelf: **two of eight** sampled entries carried a homepage at all, and a
 * homepage is the only place an icon could be found. So the fallback is not the
 * edge case here — it is what most tiles will draw, and it has to be worth
 * looking at rather than a grey box.
 *
 * **Never a broken image**, which `#1405` freezes as decision 3. A tile that
 * asks for an icon and gets a 404 draws the browser's own torn-page glyph, which
 * is worse than no icon: it reads as *this provider is broken* rather than as
 * *nobody has scouted this yet*.
 *
 * ## Why it is drawn here and the icons are not
 *
 * `D-135` moved the Atlas icon set to Font Awesome so that nobody has to invent
 * shapes. This is not a shape — it is two letters of the provider's own name in
 * the page's own colours, and there is no library that has `mail.tm`'s monogram
 * because it is derived rather than designed.
 *
 * ## Deterministic, and that is the whole of the colour rule
 *
 * The tint comes from the host string itself, so a provider looks the same on
 * every page and across restarts, and adding a provider changes nobody else's.
 * A random or sequential colour would make two adjacent tiles swap appearance
 * when a third is inserted between them.
 */

/** The palette, from the Atlas tokens — see `theme.ts`. Chosen for contrast against the tile. */
const TINTS = [
  '#2f5d8a',
  '#6b4a7d',
  '#3d6b5a',
  '#8a5a3c',
  '#4a5a8a',
  '#7d4a5a',
  '#5a7d4a',
  '#8a7a3c',
] as const

/**
 * The letters, and the rule is *one letter per part of the name, or two from it
 * if it has only one part*.
 *
 * `mail.tm` is **MA** and `github.com` is **GI** — the same shape gets the same
 * treatment, which is the property the first draft of this got wrong by reading
 * `mail.tm` as two parts and `github.com` as one. `mail.protonmail.ch` is
 * **MP**, one letter each, because there the name really does have two parts.
 *
 * The suffix is never a part: nobody says `.com` when they name a provider.
 */
export function monogramLetters(host: string): string {
  const bare = host
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/:\d+$/, '')

  /**
   * **Dropped by count and not by a list.** A registry of public suffixes is a
   * dependency and a thing to keep current, for a decision this small. The last
   * label is the suffix in every case that matters here; a two-label suffix like
   * `co.uk` would leave `google.co.uk` reading as `GC`, which is not wrong
   * enough to import a registry for.
   */
  const labels = bare.split('.').filter(Boolean)
  const named = labels.length > 1 ? labels.slice(0, -1) : labels
  const words = named.map((label) => label.replace(/[^a-z0-9]/g, '')).filter(Boolean)

  const letters =
    words.length === 1
      ? (words[0] ?? '').slice(0, 2)
      : words
          .map((word) => word.charAt(0))
          .slice(0, 2)
          .join('')

  /** A host with nothing alphanumeric in it still gets a mark rather than an empty box. */
  return (letters || bare.replace(/[^a-z0-9]/g, '').charAt(0) || '?').toUpperCase()
}

/** The same host always gets the same tint. */
export function monogramTint(host: string): string {
  let hash = 0
  for (const char of host) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return TINTS[hash % TINTS.length] ?? TINTS[0]
}

/**
 * The mark itself, inline.
 *
 * **Inline rather than a route**, unlike the cached icons: a monogram is derived
 * from a string this process already has, so a request for it would be a round
 * trip to compute two letters. It is also the failure path — the thing drawn
 * when a fetch did not work — and a failure path that needs a working request is
 * not a failure path.
 *
 * `aria-hidden`, because the provider's name is already text beside it —
 * `#1326` decision 7, the same rule the icon set has.
 */
export function providerMonogram(host: string): string {
  const letters = monogramLetters(host)
  const tint = monogramTint(host)

  return (
    '<svg class="k-provider-mark" viewBox="0 0 32 32" width="1.75em" height="1.75em" ' +
    'aria-hidden="true" focusable="false">' +
    `<rect width="32" height="32" rx="7" fill="${tint}"/>` +
    '<text x="16" y="16" fill="#fff" font-size="14" font-family="inherit" font-weight="600" ' +
    `text-anchor="middle" dominant-baseline="central">${letters}</text>` +
    '</svg>'
  )
}
