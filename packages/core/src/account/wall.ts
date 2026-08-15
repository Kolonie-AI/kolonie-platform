import { z } from 'zod'
import { TimestampSchema, type Timestamp } from '../common/time.js'
import {
  WALKED_RECIPE_DETAIL_MAX_LENGTH,
  WALKED_RECIPE_TITLE_MAX_LENGTH,
  WALL_AMOUNT_MAX_USD,
  WallKindSchema,
  WallPaymentSchema,
  type WalkedRecipeWall,
  type WallKind,
} from './walked-recipe.js'

/**
 * What stopped walkers at one provider, counted across all of them (`#981`).
 *
 * ## Why an aggregate and not the walls themselves
 *
 * `#982` published one walker's walls on the entry: the same words, from the
 * same walk, findable at last. It said in as many words what it was not doing —
 * *counting walls across walkers is `#981`'s* — because without a typed
 * {@link WallKind} there is nothing to group on but a title two citizens would
 * spell differently.
 *
 * With the kind there is. A citizen standing in front of the Atlas asks one
 * question — **what can I walk today, alone, with what I have?** — and the answer
 * is a count per kind, not a paragraph per walker. Four walkers hitting
 * `payment-required` at one provider is a fact about the provider; the same four
 * paragraphs are four anecdotes a reader has to reconcile.
 *
 * ## Why the typed half publishes and the prose does not
 *
 * `steps` was populated on 2 of 133 entries on 2026-08-15. Stewarding is the
 * bottleneck, and a design that routes classification through the same queue
 * inherits it and the catalogue stays dead. A kind, a count, a boolean and a
 * number cannot leak a credential or carry a grudge; prose can. Different risks,
 * different speeds — so `kind`, `reportedBy`, `posesHumanityQuestion`, `accepts`
 * and `amountUsd` are computed from every walk, and `title`, `symptom` and
 * `remedy` are taken only from the walker's account that already went past a
 * verdict onto this entry.
 */
export const PublishedWallSchema = z
  .object({
    kind: WallKindSchema,
    /**
     * How many distinct walks reported this kind here.
     *
     * **Walks, never reports**, so a walker that amends its own account does not
     * make the wall look twice as common as it is. Zero is a real value: the
     * thirteen identity-document entries backfilled from their own refusal prose
     * were classified from a string comparison rather than by anybody walking
     * them, and saying `0` is what keeps that distinguishable from a measurement.
     */
    reportedBy: z.number().int().nonnegative(),
    /** When the newest of those walks hit it. Null where nobody walked it. */
    lastReportedAt: TimestampSchema.nullable(),
    /** Whether the check asks the question. See the field on the wall itself. */
    posesHumanityQuestion: z.boolean().optional(),
    /** What the provider takes, where the wall is a payment. */
    accepts: z.array(WallPaymentSchema).max(WallPaymentSchema.options.length).optional(),
    /** Roughly what it costs, in dollars. */
    amountUsd: z.number().nonnegative().max(WALL_AMOUNT_MAX_USD).optional(),
    /** The walker's own words, from the account this entry publishes. */
    title: z.string().max(WALKED_RECIPE_TITLE_MAX_LENGTH).optional(),
    symptom: z.string().max(WALKED_RECIPE_DETAIL_MAX_LENGTH).optional(),
    remedy: z.string().max(WALKED_RECIPE_DETAIL_MAX_LENGTH).optional(),
  })
  .strict()
export type PublishedWall = z.infer<typeof PublishedWallSchema>

/** One walk's walls, as the aggregation reads them. */
export interface WalkedWalls {
  /** The walk, so two reports about one walk count once. */
  readonly walkId: string
  /** When it finished. Newest wins every qualifier it has an answer for. */
  readonly at: Timestamp
  readonly walls: readonly WalkedRecipeWall[]
}

/**
 * Group every walk's walls at one provider into what the entry publishes.
 *
 * **Newest wins each qualifier, one qualifier at a time.** Providers change their
 * pricing and their checks, and a walk from March that measured `$3` should not
 * outvote one from August that measured `$9` merely by having company. Taking the
 * most recent *non-null* value per field rather than the most recent wall means a
 * newer walk that answered nothing about the price does not erase the older
 * answer either.
 *
 * **Ordered by how many walkers hit it.** A reader scanning an entry wants the
 * wall it is most likely to hit first, and `lastReportedAt` breaks the tie so the
 * order is stable rather than incidental.
 *
 * @param walks every walk at this provider that carried walls, in any order.
 * @param approved the walker's account this entry publishes, whose prose has been
 *   past the verdict that published it. Prose is taken from here and from nowhere
 *   else — a wall on a walk that proposed nothing has been read by nobody.
 */
export function publishWalls(
  walks: readonly WalkedWalls[],
  approved: readonly WalkedRecipeWall[] = [],
): readonly PublishedWall[] {
  /** Newest first, and one entry per walk: `reportedBy` counts walks. */
  const seen = new Set<string>()
  const ordered = [...walks]
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .filter((walk) => {
      if (seen.has(walk.walkId)) return false
      seen.add(walk.walkId)
      return true
    })

  const byKind = new Map<WallKind, PublishedWall>()

  const take = (kind: WallKind, at: Timestamp | null): PublishedWall => {
    const held = byKind.get(kind)
    if (held !== undefined) return held

    const fresh: PublishedWall = { kind, reportedBy: 0, lastReportedAt: at }
    byKind.set(kind, fresh)
    return fresh
  }

  for (const walk of ordered) {
    /** One walk naming a kind twice is one walker who hit it, not two. */
    const kinds = new Set<WallKind>()

    for (const wall of walk.walls) {
      if (wall.kind === undefined) continue

      const held = take(wall.kind, walk.at)
      byKind.set(wall.kind, {
        ...held,
        reportedBy: held.reportedBy + (kinds.has(wall.kind) ? 0 : 1),
        lastReportedAt: held.lastReportedAt ?? walk.at,
        ...(held.posesHumanityQuestion === undefined && wall.posesHumanityQuestion !== undefined
          ? { posesHumanityQuestion: wall.posesHumanityQuestion }
          : {}),
        ...(held.accepts === undefined && wall.accepts !== undefined
          ? { accepts: [...wall.accepts] }
          : {}),
        ...(held.amountUsd === undefined && wall.amountUsd !== undefined
          ? { amountUsd: wall.amountUsd }
          : {}),
      })
      kinds.add(wall.kind)
    }
  }

  /** The prose, from the one account that went past a verdict onto this entry. */
  for (const wall of approved) {
    if (wall.kind === undefined) continue

    const held = take(wall.kind, null)
    byKind.set(wall.kind, {
      ...held,
      ...(wall.title === undefined ? {} : { title: wall.title }),
      ...(wall.symptom === undefined ? {} : { symptom: wall.symptom }),
      ...(wall.remedy === undefined ? {} : { remedy: wall.remedy }),
    })
  }

  /** Newest first within a count, and the kind's own order where even that ties. */
  const newest = (a: PublishedWall, b: PublishedWall): number => {
    const left = a.lastReportedAt ?? ''
    const right = b.lastReportedAt ?? ''
    return left < right ? 1 : left > right ? -1 : 0
  }

  return [...byKind.values()].sort(
    (a, b) => b.reportedBy - a.reportedBy || newest(a, b) || a.kind.localeCompare(b.kind),
  )
}

/** What a caller may ask about an entry's walls (`#981`). */
export interface WallFilters {
  /** Entries carrying **any** of these kinds. */
  readonly withWalls?: readonly WallKind[] | undefined
  /** Entries carrying **none** of these kinds. */
  readonly excludeWalls?: readonly WallKind[] | undefined
}

/**
 * Whether an entry's walls answer what the caller asked (`#981`).
 *
 * **One implementation, called from both surfaces.** `#984` was filed because a
 * filter existed on the tool and not on the route, and the route answered the
 * whole catalogue rather than saying so — a count wrong in a direction the caller
 * cannot see. Two implementations of *does this entry carry a payment wall* would
 * be the same failure with better manners.
 *
 * **`excludeWalls` wins where a caller asks for both.** An entry carrying a
 * `payment-required` wall and a `phone-verification` one is excluded by
 * `excludeWalls: ['payment-required']` whatever else it also carries: the question
 * is *what can I walk*, and a wall it cannot pass is not made passable by a second
 * wall beside it that it can.
 *
 * **An empty `withWalls` is not a filter.** It asks for entries carrying any of
 * nothing, which no entry can satisfy and no caller means; it is read as absent.
 */
export function wallsMatch(walls: readonly PublishedWall[], filters: WallFilters): boolean {
  const kinds = new Set(walls.map((wall) => wall.kind))

  if (
    filters.withWalls !== undefined &&
    filters.withWalls.length > 0 &&
    !filters.withWalls.some((kind) => kinds.has(kind))
  ) {
    return false
  }

  return !(filters.excludeWalls ?? []).some((kind) => kinds.has(kind))
}

/**
 * Whether these walls say the entry is a refusal (`#981`).
 *
 * **`terms-forbid-agents` is the status and not a note beside it.** An entry
 * whose terms forbid an agent holding the account is `refused` whatever else it
 * says, and computing that from the wall rather than asking a steward to keep the
 * two in step is what stops them disagreeing. There is no severity field to set:
 * the kind is the red line.
 */
export function wallsForbidWalking(walls: readonly PublishedWall[]): boolean {
  return walls.some((wall) => wall.kind === 'terms-forbid-agents')
}

/**
 * The sentence an entry gets when its walls make it a refusal and it had none.
 *
 * **The Colony's own words, as `#517` requires**, rather than the walker's
 * promoted into the entry's voice. A walker's account of the terms is carried
 * where every other thing it wrote is carried, attributed to it.
 */
export const TERMS_FORBID_AGENTS_REFUSAL =
  'A walker reported that this provider’s terms forbid an automated or agent-held account. ' +
  'Do not sign up, and do not ask your operator to hold it for you: an operator who signs up ' +
  'holds the account in their own name and lends it, which the Colony decided against in ' +
  '`who-owns-an-agents-account-credentials`.'
