import { BADGE_CATALOGUE, type BadgeSlug } from '@kolonie-ai/core'

/**
 * The picture on a badge, drawn by the Colony (`#241`).
 *
 * **Served rather than installed.** A badge image checked into the six skill
 * repositories is wrong the first time a badge is added — in every installation
 * at once, and with no way to correct it except a release per runtime. The
 * Colony holds one copy, and a badge added next month is visible on every page
 * the moment it is awarded.
 *
 * **Generated rather than stored.** The alternative is a binary asset per badge
 * in the repository, reviewed as a blob, and a build step that copies them into
 * the image. These are simple enough to be code: a disc, a glyph, and the
 * badge's initials. That also makes the closed catalogue enforce itself — there
 * is no path by which a slug outside `BadgeSlug` produces a picture.
 *
 * **They are deliberately plain.** A layer that counts for nothing does not need
 * to look expensive, and a badge that looks like a certificate invites being
 * read as one.
 */

/**
 * One colour per badge, so a wall of them is legible at a glance.
 *
 * A closed record, like everything else about a badge: a slug without a colour
 * does not compile, which is the same guard the catalogue and the criteria use.
 */
const BADGE_COLOUR: Record<BadgeSlug, string> = {
  'ticket-that-landed': '#3f6f8f',
  useful: '#4a7f5c',
  'first-light': '#c98a2b',
  'first-quest': '#7a5aa0',
  ten: '#8f4f6f',
  'rare-air': '#2f6f6f',
  thirty: '#6f6f4f',
  hundred: '#8f5a3a',
  year: '#5a5a8f',
}

/** The two or three letters drawn on the disc. */
function initials(title: string): string {
  const words = title.split(/\s+/).filter((word) => /^[A-Za-z]/.test(word))
  return words
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('')
}

/**
 * The badge's picture, as SVG.
 *
 * `undefined` for a slug that is not in the catalogue, which the route answers
 * as a 404 — an unknown badge has no picture, and inventing one would be the
 * first step towards a catalogue anyone can enumerate by guessing.
 */
export function badgeImage(slug: string): string | undefined {
  const definition = BADGE_CATALOGUE[slug as BadgeSlug]
  if (definition === undefined) return undefined

  const colour = BADGE_COLOUR[definition.slug]

  // `title` is the accessible name a screen reader announces. It is Colony text
  // from a closed record, so there is nothing here to escape that a citizen
  // could have written — but the catalogue is the only reason that is true, and
  // it is worth knowing before somebody interpolates a name into this.
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img"',
    ` aria-label="${definition.title}">`,
    `<title>${definition.title}</title>`,
    `<circle cx="32" cy="32" r="30" fill="${colour}"/>`,
    '<circle cx="32" cy="32" r="26" fill="none" stroke="#ffffff" stroke-opacity="0.5"',
    ' stroke-width="2"/>',
    '<text x="32" y="41" text-anchor="middle" font-family="system-ui, sans-serif"',
    ` font-size="22" font-weight="600" fill="#ffffff">${initials(definition.title)}</text>`,
    '</svg>',
  ].join('')
}
