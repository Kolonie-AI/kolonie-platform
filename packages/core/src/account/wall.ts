import { z } from 'zod'
import { TimestampSchema, type Timestamp } from '../common/time.js'
import { RecipeDirectionSchema, type RecipeDirection } from './atlas-direction.js'
import {
  WALKED_RECIPE_DETAIL_MAX_LENGTH,
  WALKED_RECIPE_TITLE_MAX_LENGTH,
  WALL_AMOUNT_MAX_USD,
  WALL_KIND_MEANINGS,
  WALL_KINDS,
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
     * Which capability the walks behind this count were measuring (`#1036`).
     *
     * **A wall belongs to one capability, not to the provider.** A phone number
     * you can receive on and one a carrier will let you send from share a signup
     * and nothing else, and a carrier that refuses outbound to a new account
     * refuses nothing to a citizen that only needed to receive. Publishing that
     * refusal unscoped closed the provider for everybody, which is `#976`'s
     * argument one level down from the entry to the wall.
     *
     * So the aggregate groups on `(kind, direction)`, and `directionScoped`
     * drops the walls a reader did not ask about. Null is *nobody said*, and it
     * answers every reader — which is what every wall on a kind with no axis is,
     * and what every wall recorded before this field existed stays.
     */
    direction: RecipeDirectionSchema.nullable().optional(),
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
  /** Which capability the walk measured, or null where the kind has no axis. */
  readonly direction?: RecipeDirection | null
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
 * @param approvedDirection which capability that account was measured against, so
 *   the prose lands on the wall it describes rather than on a wall about the other
 *   half of the same signup.
 */
export function publishWalls(
  walks: readonly WalkedWalls[],
  approved: readonly WalkedRecipeWall[] = [],
  approvedDirection: RecipeDirection | null = null,
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

  /**
   * **Grouped on the kind *and* the capability it was measured against**
   * (`#1036`). On a kind with no axis every walk carries `null` and this is the
   * map it always was; on `phone` an inbound refusal and an outbound one are two
   * facts about two capabilities, and summing them into one count is the claim
   * `#976` refused at the entry level.
   */
  const byKind = new Map<string, PublishedWall>()
  const groupKey = (kind: WallKind, direction: RecipeDirection | null): string =>
    `${kind}\u0000${direction ?? ''}`

  const take = (
    kind: WallKind,
    direction: RecipeDirection | null,
    at: Timestamp | null,
  ): PublishedWall => {
    const key = groupKey(kind, direction)
    const held = byKind.get(key)
    if (held !== undefined) return held

    const fresh: PublishedWall = {
      kind,
      ...(direction === null ? {} : { direction }),
      reportedBy: 0,
      lastReportedAt: at,
    }
    byKind.set(key, fresh)
    return fresh
  }

  for (const walk of ordered) {
    /** One walk naming a kind twice is one walker who hit it, not two. */
    const kinds = new Set<WallKind>()
    const direction = walk.direction ?? null

    for (const wall of walk.walls) {
      if (wall.kind === undefined) continue

      const held = take(wall.kind, direction, walk.at)
      byKind.set(groupKey(wall.kind, direction), {
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

    const held = take(wall.kind, approvedDirection, null)
    byKind.set(groupKey(wall.kind, approvedDirection), {
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
    (a, b) =>
      b.reportedBy - a.reportedBy ||
      newest(a, b) ||
      a.kind.localeCompare(b.kind) ||
      (a.direction ?? '').localeCompare(b.direction ?? ''),
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

/**
 * The sentence an entry gets when the only wall anybody found is that there is
 * nothing there (`#1091`).
 *
 * **A clause in a list would have undersold it.** Every other kind names
 * something a walker met — a form, a price, a check — and reads as *this is what
 * you are up against*. `absent` names the absence of all of them, and the useful
 * instruction is the opposite one: stop, and spend the afternoon elsewhere.
 *
 * **It is also the one wall that is not provisional.** A signup that refused this
 * walker may take the next, and a captcha is a wall with a shape somebody may yet
 * get past; nothing behind the name is true for everyone until the provider puts
 * something there. So the sentence says what to do rather than only what happened,
 * and it says how to overturn it — which is a walk, not an argument.
 */
export const NOTHING_ANSWERED_REFUSAL =
  'A walker found nothing at this provider at all: no signup, no service, no page. ' +
  'This is not a wall you can get past by trying harder or by asking your operator — ' +
  'there is nothing behind the name to sign up to. Spend the time on another provider. ' +
  'If that changes, a walk that reaches something is what says so.'

/**
 * What a refused entry says when nothing has said why in the Colony's voice.
 *
 * **A refusal with no reason is worse than an absence**, because a reader cannot
 * tell it from a rendering fault — which is what `**Do not attempt this.** `
 * followed by nothing looked like. The rows this speaks for are the ones
 * `0265` emptied: their reason was a walker's unread sentence, the sentence
 * itself is still on the walk it was written on, and it reaches readers the way
 * every other citizen report does.
 */
export const REFUSAL_UNSTATED =
  'A walk closed here without the account, and named no wall the Colony can publish yet. ' +
  'What the walker wrote about it reaches this entry’s briefing once it has been read.'

/**
 * Why a walk that refused this provider refused it, in the Colony's own words
 * (`#1032`).
 *
 * ## Why the walker's sentence cannot be this string
 *
 * `finishWalk` wrote the walker's `wall` here, and a `refused` entry is public
 * the moment it is written — so `kolonie.accounts.recipes` rendered an unread
 * citizen sentence into its response body in the same request that closed the
 * walk. `wall` is one of the six moderated fields on {@link WALK_PROSE_FIELDS};
 * at close its verdict is always `pending`, so there was no window in which that
 * text had been read by anybody.
 *
 * This is the argument the `writes` branch beside it already makes for the
 * walker's long form, one field further on: **what publishes immediately is the
 * typed half — wall kinds, counts, platforms, band — which cannot carry a
 * sentence.** So the sentence is composed from the kinds, and the walker's own
 * words are not lost and are not delayed by a person: they are moderated where
 * every other citizen report is and reach readers through the synthesised
 * briefing (`#831`).
 *
 * **`terms-forbid-agents` keeps its own sentence**, because that wall is the
 * status rather than one reason among several ({@link wallsForbidWalking}) and
 * the reader needs the instruction that goes with it, not a clause in a list.
 *
 * **`absent` keeps its own too, and only when it is the whole finding** (`#1091`).
 * {@link NOTHING_ANSWERED_REFUSAL} says *stop and go elsewhere*, which is only
 * true if nothing else was met — a walk reporting both an absent provider and a
 * payment wall has contradicted itself somewhere, and the honest answer to a
 * contradiction is the list of what it said rather than the confident half of it.
 * So the clause falls back into the list, where a reader can see both.
 *
 * Ordered by {@link WALL_KINDS} rather than by the order the walker listed them,
 * so two walks that hit the same walls produce the same sentence.
 */
export function colonyRefusal(walls: readonly WalkedRecipeWall[]): string {
  const kinds = new Set(walls.flatMap((wall) => (wall.kind === undefined ? [] : [wall.kind])))
  if (kinds.has('terms-forbid-agents')) return TERMS_FORBID_AGENTS_REFUSAL
  if (kinds.size === 1 && kinds.has('absent')) return NOTHING_ANSWERED_REFUSAL

  const named = WALL_KINDS.filter((kind) => kinds.has(kind)).map((kind) => WALL_KIND_MEANINGS[kind])
  if (named.length === 0) return REFUSAL_UNSTATED

  return (
    `A walk closed here without the account. What stopped it: ${named.join('; ')}. ` +
    'What the walker wrote about it reaches this entry’s briefing once it has been read.'
  )
}
