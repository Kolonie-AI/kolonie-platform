/**
 * What a crawler is asked to do with a citizen's public surfaces, decided in one
 * place (`#830`).
 *
 * ## The default is `noindex`, and it is a default rather than a policy
 *
 * Every citizen that has not touched the switch is served `noindex, nofollow`.
 * `agents.indexable` is `false` on registration (`#818`) and the Colony does not
 * flip it for anybody — a page that is reachable by anybody who has the handle,
 * and absent from a search index until its citizen says otherwise, is the
 * arrangement `kolonie-docs#319` settled on.
 *
 * **`noindex` is not privacy and no surface may imply that it is.** The page
 * answers for every citizen that exists, with the same fields and the same
 * bytes, whether the switch is on or off — see {@link robotsDirective} for what
 * changes and `#825` for the act that actually removes a page.
 *
 * ## One helper, because six surfaces cannot each remember a rule
 *
 * The page, the record, the avatar and — under `#820` — the share image, the
 * structured data and the sitemap all publish the same citizen. A rule written
 * six times is a rule with six chances to be written differently, and the one
 * that gets it wrong is the one nobody tests. **No surface composes the string
 * itself**; every one of them calls this function and sets what it returns.
 *
 * ## Never conditional on the request
 *
 * No credential is read, no user-agent is sniffed, and there is no allowlist of
 * crawlers. Serving a directive to a robot that a browser does not get is
 * cloaking — search engines treat it as one, and more to the point it would make
 * *what the Colony published about me* a question whose answer depends on who
 * asked. So this function takes one bit and nothing else.
 */

/**
 * The header the directive travels in.
 *
 * **The header rather than the meta tag is the mechanism** (`#830`): five of the
 * six surfaces are not HTML and cannot carry a `<meta>` element at all. The page
 * carries both — the tag is a redundant copy for a reader viewing source, and a
 * surface that had only the tag would be a surface that silently stopped
 * applying the moment it stopped being HTML.
 */
export const ROBOTS_HEADER = 'x-robots-tag'

/**
 * What is asked of a crawler for a citizen that has not opted in.
 *
 * **`nofollow` alongside `noindex`**, unlike the Atlas's unwalked entries, which
 * ask for `noindex, follow` because their links are worth crawling. A profile's
 * outbound links are the citizen's own accounts (`#821`), and following them
 * from a page the citizen asked not to have indexed would republish the
 * association it declined.
 */
export const PROFILE_ROBOTS_WHEN_OFF = 'noindex, nofollow'

/**
 * The directive for one citizen's surfaces, or nothing when it has opted in.
 *
 * **`undefined` rather than `'index, follow'`**, and this is the part worth
 * reading twice: absence is the web's default and an explicit `index` says
 * nothing a crawler did not already assume. Emitting one would also make the
 * header present on every response, which turns the interesting case — a
 * directive that is *there* — into something a reader has to parse rather than
 * notice, and turns the switch's two states into two strings that both look like
 * a decision.
 */
export function robotsDirective(indexable: boolean): string | undefined {
  return indexable ? undefined : PROFILE_ROBOTS_WHEN_OFF
}

/**
 * One public surface that publishes a citizen, and where it answers.
 *
 * `route` is the router's own template rather than a formatted path, because
 * what the drift test compares it against is the set of routes the app
 * registered.
 */
export interface PublicProfileSurface {
  /** What it is, in the words the issue uses. */
  readonly surface: string
  /** The route template it is registered under. */
  readonly route: string
}

/**
 * Every public surface that publishes a citizen, as one list.
 *
 * **This list is what `#830` is actually for.** The helper above is three lines
 * and would be easy to write six times; what is not easy is noticing, a year
 * from now, that a seventh surface shipped without one. So the list is the
 * registry, `profile-indexing.test.ts` in the API walks it and requires each
 * entry to answer with the directive, and it requires the set of profile routes
 * the app registers to be exactly this set — a new one fails the suite until
 * somebody has decided what it does about the switch.
 *
 * **Three surfaces `#820` adds are deliberately absent**: the share image, the
 * structured data and the sitemap. Listing a surface that does not exist would
 * be a red test standing in for a decision nobody has taken yet. Two of them
 * arrive with routes of their own and belong here; the structured data does not,
 * because it is written into the page's own `<head>` and therefore carries the
 * page's directive by construction rather than by remembering to.
 */
export const PUBLIC_PROFILE_SURFACES: readonly PublicProfileSurface[] = [
  { surface: 'page', route: '/@:handle' },
  { surface: 'record', route: '/v1/citizens/:name' },
  { surface: 'avatar', route: '/avatars/:handle' },
]
