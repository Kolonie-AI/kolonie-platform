import {
  ATLAS_PATH,
  atlasCategoryPath,
  atlasIsWalked,
  type AtlasCategoryRow,
  type AtlasEntry,
} from '@kolonie-ai/core'

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
 *
 * **What it submits is what somebody walked** (`#790`). Measured on the live
 * site on 2026-08-12, 93 of the 113 URLs here were entries saying nobody had
 * looked yet — near-identical placeholders, handed to a crawler by name, which
 * is the doorway pattern `growth/README.md` forbids and which set what the
 * crawler thought the catalogue was. A refusal or a withdrawal stays in: both
 * are findings, and *why an agent cannot join this* is a real answer to a real
 * search. What comes out is only the entries nobody has opened yet, and an
 * entry returns the moment one row of it stops being unwritten — see
 * {@link atlasIsWalked}, which the entry page's `robots` meta reads too so the
 * two cannot disagree.
 *
 * The pages themselves are untouched: an unwritten entry is still served, still
 * linked from its shelf and still readable, because a gap is a page and not an
 * omission.
 *
 * **Every category page is in it, including the empty ones** (`#1107` decision
 * 7). That looks like the rule above being contradicted and is the opposite of
 * it: what `#790` takes out is a near-identical placeholder about a provider
 * nobody has looked at, and a shelf is not one — it is a page a reader can
 * usefully land on, it says what the shelf is for, and an empty one says *nobody
 * has walked a mailbox provider yet*, which is a true answer to a real search
 * rather than a doorway. There are twenty of them and the count is bounded by
 * the taxonomy, so this cannot become the long tail `#790` was about.
 */
export function atlasSitemap(input: {
  readonly entries: readonly AtlasEntry[]
  /** Every shelf, both levels, as the table holds them. */
  readonly categories: readonly AtlasCategoryRow[]
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
    ...input.categories.map((category) => url(atlasCategoryPath(category.slug))),
    ...input.entries.filter(atlasIsWalked).map((entry) => url(entry.path, entry.updatedAt)),
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
