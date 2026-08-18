import { PLAYBOOKS_PATH, playbookPath, type Playbook } from '@kolonie-ai/core'

/**
 * The playbook catalogue's sitemap (`#1220`).
 *
 * **The one thing a dynamic surface needs that a built one gets for free**, and
 * the reason `atlas/sitemap.ts` exists in the same words: an Astro build
 * enumerates its own pages, a route rendering from a table does not, so without
 * this a crawler finds only what happens to be linked.
 *
 * **`open` only, and the caller has already narrowed it.** A blocked playbook is
 * served, linked and forkable, and it carries `noindex` — submitting it here
 * would be the sitemap asking a crawler to index a page the page itself asks it
 * not to. `draft`, `review` and `retired` never reach this surface at all.
 */
export function playbookSitemap(input: {
  readonly playbooks: readonly Playbook[]
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
    url(PLAYBOOKS_PATH),
    ...input.playbooks.map((playbook) => url(playbookPath(playbook.slug), playbook.updatedAt)),
    '</urlset>',
  ].join('\n')
}

/**
 * The five characters, again — and again not the console's `escape`, which is
 * written for HTML. See `atlas/sitemap.ts` for the whole of the argument.
 */
function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}
