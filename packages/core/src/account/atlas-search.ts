import { z } from 'zod'
import { SignupCostSchema, ProviderTermsSchema } from './atlas-conditions.js'

/**
 * Reading the Atlas at the size it is growing to (`#1302`).
 *
 * ## The problem this exists for
 *
 * Every filter the catalogue has narrows by a closed vocabulary somebody chose:
 * a shelf, a wall kind, an earn facet, a status. That is the right shape for the
 * question *what sort of thing is this*, and it cannot answer the question a
 * scout actually asks, which is *do we already know anything about `gmx.com`*.
 * At 133 entries that was answerable by reading the whole shelf. At the
 * hundreds-to-thousands `#1295` is aiming for it is not, and the failure mode is
 * not slowness — it is a scout walking a provider the Atlas already has, because
 * the only way to find out was to page past it.
 *
 * ## Substring and not a ranked search
 *
 * **No scoring, no stemming, no relevance order.** The catalogue's order is
 * `atlasByOutcome`, which is derived from what was measured and is deliberately
 * something nobody can buy (`#855`). A relevance score computed from a query
 * string would be a second ordering laid over that one, and the first time a
 * provider ranked above another for containing the word twice, the guarantee
 * `atlasRank` exists to make would be gone. So this filters and never sorts:
 * what matches is returned in the order the catalogue was already in.
 *
 * **Three fields and not the steps.** Provider, title and description are what
 * identify an entry. The steps are prose about how to get in, and a query that
 * matched them would return the entry for `example.com` because some other
 * provider's step three says *forward the mail to example.com* — a match the
 * reader cannot see and would have to disprove.
 *
 * ## Why the cost filter is here and not on the shelf
 *
 * `cost` was readable on an entry from `#815` and filterable by nobody: an agent
 * with no card had to fetch the catalogue and re-derive *which of these can I
 * actually pay for*. It is per row, exactly as the walls and the earn facets
 * are, because a provider's mailbox may be free while its API is paid-only, and
 * dropping the provider would hide the row the reader asked about.
 *
 * **`unknown` is a value and never a wildcard.** `cost: 'free'` does not match a
 * row nobody has priced — that row is the one a scout should go and price, and
 * folding it into the free ones would be the catalogue claiming a measurement it
 * does not have.
 *
 * ## `terms` is known here and wired to nothing, deliberately
 *
 * {@link atlasConditionsMatch} and {@link invalidAtlasCondition} both understand
 * it, and neither the MCP tool nor the data route passes it. `#815` is explicit:
 * that field *drives a sentence on the entry and nothing else — no gate, no
 * hiding, no refusal*, and **if a later change makes this field hide an entry,
 * it is reversing a decision and not tidying an oversight**. A filter hides
 * entries. So the vocabulary stays where a validator can name a typo in it, and
 * turning it into a filter costs one line here and a decision somewhere else —
 * which is the shape a reversal of a recorded decision should have.
 */

/**
 * How long a query may be.
 *
 * **Short on purpose.** This matches a provider name, a title or a sentence, and
 * a caller sending a paragraph is asking for a search this is not; refusing at
 * the schema says so in one round trip instead of returning an empty catalogue
 * that reads as *the Atlas knows nothing*.
 */
export const ATLAS_QUERY_MAX_LENGTH = 100

/**
 * How many entries one page of the catalogue carries when the caller names a
 * size.
 *
 * **A ceiling, not the default.** The catalogue answered unpaginated while it
 * was 133 entries; a reader asking for `mail` at a thousand entries should not
 * be handed everything that matched. An omitted `limit` is a different
 * question — see {@link ATLAS_ENTRIES_DEFAULT_PAGE}.
 */
export const ATLAS_ENTRIES_MAX_PAGE = 50

/**
 * How many entries an omitted `limit` returns (`#1860`).
 *
 * **Smaller than the ceiling on purpose.** D-149: an omitted limit is a default,
 * not an invitation to the documented maximum. A citizen measured the 50-entry
 * MCP page at 110,606 bytes on 2026-09-03, which is the Doctor's
 * unreadable-response finding arriving as the ordinary read. Five is the page
 * that stays under 64 KiB on a representative current-schema fixture while
 * still carrying a `nextCursor` whenever more remains. A caller that wants the
 * ceiling names it.
 */
export const ATLAS_ENTRIES_DEFAULT_PAGE = 5

export const AtlasQuerySchema = z.string().trim().min(1).max(ATLAS_QUERY_MAX_LENGTH)

/**
 * What a catalogue read may be narrowed by beyond the closed vocabularies
 * (`#1302`).
 */
export interface AtlasSearchFilters {
  /** Substring, case-insensitive, over provider, title and description. */
  readonly q?: string | undefined
  /** Where the money is required, per row. */
  readonly cost?: readonly string[] | undefined
  /** What the provider's terms say about an agent holding it, per row. */
  readonly terms?: readonly string[] | undefined
  /**
   * Only entries that have a sentence saying what the provider is, or only the
   * ones that do not.
   *
   * **Both directions are useful and they are different jobs.** `true` is a
   * reader choosing between providers and wanting to know what they are;
   * `false` is a scout looking for the work — `#1297` made `about` first-class
   * and this is how a citizen finds the entries still missing one.
   */
  readonly hasDescription?: boolean | undefined
}

/**
 * Whether one entry's identity matches the query.
 *
 * **Normalised on both sides, and by lowering rather than by folding accents.**
 * A provider is a domain, so ASCII case is the whole of the variation that
 * matters here; anything cleverer would make the match depend on a Unicode
 * table the caller cannot see.
 */
export function atlasMatchesQuery(
  entry: {
    readonly provider: string
    readonly title: string
    readonly description?: string | null | undefined
  },
  query: string | undefined,
): boolean {
  if (query === undefined) return true

  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return true

  return [entry.provider, entry.title, entry.description ?? '']
    .join('\n')
    .toLowerCase()
    .includes(needle)
}

/**
 * Whether one row's signup conditions match what the reader asked for.
 *
 * **A row and not an entry**, for the reason the walls give: a provider whose
 * mailbox is free and whose API is paid-only is two answers, and the reader gets
 * the row it can act on rather than losing the provider.
 */
export function atlasConditionsMatch(
  recipe: { readonly cost: string; readonly terms: string },
  filters: Pick<AtlasSearchFilters, 'cost' | 'terms'>,
): boolean {
  if (
    filters.cost !== undefined &&
    filters.cost.length > 0 &&
    !filters.cost.includes(recipe.cost)
  ) {
    return false
  }

  return !(
    filters.terms !== undefined &&
    filters.terms.length > 0 &&
    !filters.terms.includes(recipe.terms)
  )
}

/**
 * Whether the entry answers the `hasDescription` question, if one was asked.
 *
 * **An empty string counts as absent.** The column is nullable and the rollup
 * writes `null`, but a curator who saved a blank field has an entry with no
 * sentence on it, and a reader filtering for described entries would be handed
 * one that renders as a gap.
 */
export function atlasHasDescription(entry: { readonly description?: string | null }): boolean {
  return (entry.description ?? '').trim().length > 0
}

/**
 * What is wrong with a condition filter, if anything.
 *
 * **Named rather than dropped**, which is `#984`'s rule arriving on two more
 * arguments: a filter silently ignored is a count that is wrong in a direction
 * the caller cannot see. The message lists the vocabulary because both of these
 * are closed enums a caller can read off the refusal.
 */
export function invalidAtlasCondition(
  name: 'cost' | 'terms',
  values: readonly string[],
): { readonly code: 'validation_failed'; readonly message: string } | null {
  const allowed: readonly string[] =
    name === 'cost' ? SignupCostSchema.options : ProviderTermsSchema.options

  const wrong = values.filter((value) => !allowed.includes(value))
  if (wrong.length === 0) return null

  return {
    code: 'validation_failed',
    message:
      `${name} takes ${allowed.join(', ')}, and ${wrong.join(', ')} ${wrong.length === 1 ? 'is' : 'are'} ` +
      `none of them. \`unknown\` is a value here and never a wildcard: it is the row nobody has ` +
      `read, which is the one worth walking.`,
  }
}

/**
 * A page boundary in the catalogue, as something a caller can hand back.
 *
 * ## Why the cursor names an entry rather than counting them
 *
 * The catalogue's order is recomputed on every read from what was measured, so
 * an offset is a promise the next read cannot keep: one walk landing between two
 * pages moves every entry after it, and the reader silently skips one or sees it
 * twice. Naming the last provider it saw survives that — the next page resumes
 * after that provider wherever it now sits.
 *
 * **The offset travels beside it as the fallback and not as the cursor.** A
 * provider can leave the catalogue between two pages — renamed, merged, or
 * filtered out by a query the caller changed — and a cursor that could then only
 * fail would make paging brittle for the one case it is meant to survive.
 */
export interface AtlasCursor {
  /** The provider the last page ended on. */
  readonly after: string
  /** Where it was, for the read that can no longer find it. */
  readonly offset: number
}

/**
 * The cursor as a string, opaque on purpose.
 *
 * **Base64url of JSON and not the provider name in the clear.** A cursor that
 * reads as a provider is a cursor callers construct by hand, and the first
 * change to what it carries breaks every one of them. Opaque says *send it back
 * as it was given*, which is the contract the walks page already states.
 */
export function encodeAtlasCursor(cursor: AtlasCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

/** The other half, refusing anything that is not one of ours. */
export function decodeAtlasCursor(raw: string): AtlasCursor | 'invalid-cursor' {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))

    const read = z
      .object({ after: z.string().min(1), offset: z.number().int().min(0) })
      .safeParse(parsed)

    return read.success ? read.data : 'invalid-cursor'
  } catch {
    return 'invalid-cursor'
  }
}

/**
 * One page of entries, and where the next one starts.
 *
 * **`nextCursor` is null on the last page rather than absent**, so a caller
 * loops on a value it can read rather than on a key it has to test for.
 */
export interface AtlasPage<T> {
  readonly entries: readonly T[]
  readonly nextCursor: string | null
  /** How many entries matched, across every page. */
  readonly total: number
}

/**
 * Cut a filtered catalogue into a page.
 *
 * **Clamped and never refused.** A caller asking for five hundred gets fifty:
 * the ceiling is a property of the response, and refusing would only make every
 * caller learn the number by being refused once — which is the line the walks
 * page already takes.
 *
 * **An omitted limit is the default, not the ceiling** (`#1860`). Naming no
 * size used to mean fifty, which is how a successful MCP catalogue read crossed
 * 64 KiB. The explicit maximum is still available; it has to be asked for.
 */
export function atlasPageOf<T extends { readonly provider: string }>(
  entries: readonly T[],
  options: { readonly limit?: number | undefined; readonly cursor?: AtlasCursor | undefined } = {},
): AtlasPage<T> {
  const limit = Math.max(
    1,
    Math.min(ATLAS_ENTRIES_MAX_PAGE, Math.floor(options.limit ?? ATLAS_ENTRIES_DEFAULT_PAGE)),
  )

  const start = ((): number => {
    if (options.cursor === undefined) return 0

    const found = entries.findIndex((entry) => entry.provider === options.cursor?.after)

    /**
     * **After the named provider when it is still here, and at the recorded
     * offset when it is not.** The second case is the one the offset exists for
     * and it is deliberately not an error: a provider that left the shelf
     * between two pages should cost the reader the entry, not the walk through
     * the rest of the catalogue.
     */
    return found >= 0 ? found + 1 : Math.min(options.cursor.offset, entries.length)
  })()

  const page = entries.slice(start, start + limit)
  const end = start + page.length
  const last = page.at(-1)

  return {
    entries: page,
    nextCursor:
      end < entries.length && last !== undefined
        ? encodeAtlasCursor({ after: last.provider, offset: end })
        : null,
    total: entries.length,
  }
}
