import { isPublicPath, openApiPath, type RegisteredRoute } from './openapi/document.js'

/**
 * What the router would nearly have matched, said in the 404 (`#1129`).
 *
 * **The complaint.** `No route for PUT /v1/vault/phone/agentphone.ai/assay` is
 * true and tells a caller nothing it did not already know: it names the path
 * the caller just sent. Nothing in it separates *this path does not exist* from
 * *this path exists and the value you put in it is not one segment*, and a
 * citizen in `kolonie-docs#425` spent the difference in probes while holding
 * real credentials.
 *
 * **Asked of the route table, never guessed.** The candidates are the routes
 * Fastify actually registered — the same list `/openapi.json` is built from,
 * filtered by the same {@link isPublicPath} and spelled by the same
 * {@link openApiPath}. A hardcoded list of paths with special 404 prose would be
 * a second description of this API, which `docs/decisions.md` D-002 rejects
 * under *one record, or none*: it would go stale the first time a route moved,
 * and nothing would notice.
 *
 * **It says nothing a stranger may not hear.** A 404 body is answered before
 * any credential is checked, so everything here is said to anybody. Naming a
 * *pattern* is already public — `/openapi.json` names all of them without a
 * key. Naming a *value* would not be, and cannot happen here by construction:
 * every comparison below is against `:param` positions, which match any
 * segment, so a hint is identical whether or not the value in the URL exists.
 * There is no reading of the sentence this returns that is an oracle.
 *
 * **Private prefixes are not candidates.** `/v1/console`, `/v1/internal` and
 * `/v1/steward` are absent from the document for the same reason they are absent
 * here, and a caller mistyping one gets the plain 404 it always got.
 */

/** A registered path, its methods, and how nearly it matched. */
interface NearMiss {
  /** The route in OpenAPI's spelling: `/v1/vault/{key}`. */
  pattern: string
  /** The methods registered at it, `HEAD` and `OPTIONS` dropped. */
  methods: string[]
  /** Which kind of miss this is; lower sorts first. */
  rank: number
}

/** The path as segments, with the query string and any trailing slash gone. */
function segments(url: string): string[] {
  return (url.split('?')[0] ?? '').split('/').filter(Boolean)
}

const isParam = (part: string): boolean => part.startsWith(':')

/** Whether a route's parts cover the sent segments position for position. */
function coversPrefix(parts: string[], sent: string[], upTo: number): boolean {
  for (let index = 0; index < upTo; index += 1) {
    const part = parts[index] ?? ''
    if (!isParam(part) && part !== sent[index]) return false
  }
  return true
}

/**
 * Whether two segments are one keystroke apart — `task` and `tasks`.
 *
 * **A near miss has to be near.** Without this, *exactly one literal differs*
 * matches every three-segment route in the API at once, and the sentence
 * degrades into a list of unrelated paths that names the right one by accident.
 * Levenshtein at a bound of one, computed on two path segments, so the cost is
 * the length of a segment and there is nothing to tune.
 */
function oneEditApart(left: string, right: string): boolean {
  if (left === right) return false
  if (Math.abs(left.length - right.length) > 1) return false

  // A substitution: same length, and the strings agree everywhere but once.
  if (left.length === right.length) {
    let differing = 0
    for (const [index, character] of [...left].entries()) {
      if (character !== right[index]) differing += 1
      if (differing > 1) return false
    }
    return differing === 1
  }

  // An insertion, read as a deletion from the longer of the two.
  const [longer, shorter] = left.length > right.length ? [left, right] : [right, left]
  for (let index = 0; index < longer.length; index += 1) {
    if (`${longer.slice(0, index)}${longer.slice(index + 1)}` === shorter) return true
  }
  return false
}

/** Whether the route is the sent path with exactly one segment misspelled. */
function oneSegmentMisspelled(parts: string[], sent: string[]): boolean {
  if (parts.length !== sent.length) return false

  let misspelled = 0
  for (const [index, part] of parts.entries()) {
    // A param matches whatever is there, so it can never be the typo.
    if (isParam(part)) continue

    const there = sent[index] ?? ''
    if (part === there) continue
    if (!oneEditApart(part, there)) return false
    misspelled += 1
    if (misspelled > 1) return false
  }
  return misspelled === 1
}

/** Every public route, one entry per path, with the methods it answers. */
function candidates(routes: readonly RegisteredRoute[]): Map<string, string[]> {
  const byPath = new Map<string, string[]>()

  for (const route of routes) {
    // A wildcard route matches everything under it, so it cannot be a near
    // miss: had one been registered on this path, the request would have
    // reached it rather than this handler.
    if (!isPublicPath(route.url) || route.url.includes('*')) continue

    const methods = (Array.isArray(route.method) ? route.method : [route.method]).filter(
      (method) => method !== 'HEAD' && method !== 'OPTIONS',
    )
    if (methods.length === 0) continue

    const known = byPath.get(route.url) ?? []
    byPath.set(route.url, [...new Set([...known, ...methods])])
  }

  return byPath
}

/** At most this many patterns are named; beyond it the sentence stops helping. */
const NAMED_AT_MOST = 3

/**
 * The sentence to add to a 404, or `undefined` when nothing came close.
 *
 * Four kinds of miss, in the order they are worth saying:
 *
 * 1. **The path is registered and the method is not.** The single most
 *    actionable answer, and the one Fastify's own 404 hides completely.
 * 2. **A `:param` was handed more than one segment.** The `#425` case: the
 *    caller sent a value with a `/` in it, which is a longer path rather than a
 *    longer value. Only said where the pattern *ends* in a param, because that
 *    is the only shape where the surplus can be the value.
 * 3. **One segment short.** The caller stopped at `/v1/vault`.
 * 4. **One literal segment misspelled.** `/v1/task/abc` for `/v1/tasks/{taskId}`
 *    — the misconfiguration `#835` names as a shape the call rollup exists to
 *    catch, told to the agent making it rather than only to us. Bounded by
 *    {@link oneEditApart}, because *one literal differs* on its own matches
 *    every route of that length in the API.
 */
export function nearestRouteHint(
  method: string,
  url: string,
  routes: readonly RegisteredRoute[],
): string | undefined {
  const sent = segments(url)
  if (sent.length === 0) return undefined

  const misses: NearMiss[] = []

  for (const [routeUrl, methods] of candidates(routes)) {
    const parts = segments(routeUrl)
    const pattern = openApiPath(routeUrl)

    if (parts.length === sent.length && coversPrefix(parts, sent, parts.length)) {
      // It matched, so the method is what did not — anything else would have
      // been routed and never reached the not-found handler.
      if (!methods.includes(method)) misses.push({ pattern, methods, rank: 1 })
      continue
    }

    if (
      sent.length > parts.length &&
      parts.length > 0 &&
      isParam(parts[parts.length - 1] ?? '') &&
      coversPrefix(parts, sent, parts.length)
    ) {
      misses.push({ pattern, methods, rank: 2 })
      continue
    }

    if (parts.length === sent.length + 1 && coversPrefix(parts, sent, sent.length)) {
      misses.push({ pattern, methods, rank: 3 })
      continue
    }

    if (oneSegmentMisspelled(parts, sent)) misses.push({ pattern, methods, rank: 4 })
  }

  if (misses.length === 0) return undefined

  const rank = Math.min(...misses.map((miss) => miss.rank))
  const best = misses
    .filter((miss) => miss.rank === rank)
    .sort((left, right) => left.pattern.localeCompare(right.pattern))
    .slice(0, NAMED_AT_MOST)

  const named = best.map((miss) => `\`${miss.pattern}\``).join(' or ')

  if (rank === 1) {
    const answers = [...new Set(best.flatMap((miss) => miss.methods))].sort().join(', ')
    return `The path is registered as ${named}, which answers ${answers} rather than ${method}.`
  }

  if (rank === 2) {
    const trailing = segments(best[0]?.pattern ?? '').at(-1)
    // The parameter by name where one route came closest, and a phrase where
    // several did: `{key}` helps only when it is unambiguously the one meant.
    const parameter = best.length === 1 && trailing ? `\`${trailing}\`` : 'its last parameter'
    return (
      `The nearest registered route is ${named}, and ${parameter} is one segment — ` +
      `a value containing \`/\` has to be percent-encoded as \`%2F\`.`
    )
  }

  if (rank === 3) return `The nearest registered route is ${named}, which takes one more segment.`

  return `The nearest registered route is ${named}.`
}
