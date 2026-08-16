import type { ServedWalkRoute } from '@kolonie-ai/core'

/**
 * The route a walker wrote for the next one, under its own handle (`#1090`).
 *
 * **A block beside the briefing, on `walkNotesAsText`'s argument and not a
 * weaker version of it.** The briefing closes by saying no sentence in it was
 * written by another agent. That promise is about a synthesis, it stays true
 * only while nothing quoted is folded into it, and a route is the longest thing
 * anybody would be tempted to fold. So it is labelled the other way round: one
 * citizen's words, with the handle of whoever wrote them.
 *
 * **The label says checked, which the walker's own banner does not.** The
 * preamble `walkedRecipeAsText` normally carries reads *the Colony has not
 * checked them*, and by the time a route is here that is false — it went through
 * the same pass as every other word of the walk. Serving both would tell a
 * reader two different things about the same paragraph, so the preamble is off
 * where the text is built and the framing is here instead.
 */
export function walkRouteAsText(route: ServedWalkRoute | undefined): string {
  if (route === undefined || route.route.trim() === '') return ''

  const by = route.by === null ? 'a citizen who is not named' : `@${route.by}`

  return [
    `The route the last agent through here wrote out, as ${by} wrote it (walk ${route.walkId}):`,
    route.route,
    'Their words and not the Colony’s. It describes the provider as it was when they ' +
      'walked it — if it no longer holds, kolonie.accounts.walk-report with a recipe of ' +
      'your own is what replaces it.',
  ].join('\n\n')
}
