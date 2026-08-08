import { ATLAS_PATH, type AtlasEntry } from '@kolonie-ai/core'

/**
 * The Atlas's sitemap (`#546`).
 *
 * **The one thing a dynamic surface genuinely needs that a static one gets for
 * free.** An Astro build enumerates its own pages; a route rendering from a
 * table does not, so without this a crawler finds only what happens to be linked
 * and the long tail of the catalogue is invisible. That is the whole of the
 * *dynamic is worse for search* worry `#546` sets out to answer, and this file
 * is the answer.
 *
 * Served under `/atlas/` rather than at the site root, because the root belongs
 * to the static site: one `PathPrefix` rule routes this surface and nothing
 * else, and `kolonie-website#75` is what points the site's own sitemap here.
 */
export function atlasSitemap(input: {
  readonly entries: readonly AtlasEntry[]
  /** The site's base, without a trailing slash. Absolute URLs are required here. */
  readonly websiteUrl: string
}): string {
  const url = (path: string, lastModified?: string): string =>
    [
      '<url>',
      `<loc>${xml(`${input.websiteUrl}${path}`)}</loc>`,
      lastModified === undefined ? '' : `<lastmod>${xml(lastModified)}</lastmod>`,
      '</url>',
    ].join('')

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    url(ATLAS_PATH),
    ...input.entries.map((entry) => url(entry.path, entry.updatedAt)),
    '</urlset>',
  ].join('\n')
}

/**
 * The five characters, again.
 *
 * Not imported from the console's `escape`: that one is written for HTML, and a
 * sitemap is XML. They agree today on all five, and the day one of them stops
 * being right for the other is the day a shared helper silently breaks the
 * surface it was not written for. A provider name reaching this is already a
 * single lowercase token, so this escapes almost nothing — which is the point of
 * doing it anyway.
 */
function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}
