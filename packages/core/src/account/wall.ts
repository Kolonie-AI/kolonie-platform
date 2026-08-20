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
  WallStandsSchema,
  type WalkedRecipeWall,
  type WallKind,
  type WallStands,
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
     * Whether the walls behind this count stood in front of the account or in
     * front of the capability (`#1062`).
     *
     * **Grouped on, and not merged into a majority.** A provider that hands out
     * a free account and puts a card in front of the job carries both, and
     * summing them would publish one paywall that is true of neither: a reader
     * asking *what does an account here cost me* and a reader asking *what does
     * using it cost me* get different answers, exactly as `#1036` split a wall
     * by the capability it was measured against.
     *
     * Absent is the account, which is what every wall recorded before this
     * field existed meant and stays meaning.
     */
    stands: WallStandsSchema.optional(),
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
   *
   * **And on what it stood in front of** (`#1062`). A paywall between an agent
   * and the signup and a paywall between the account and the thing it was for
   * are the same kind and not the same wall, so they are two rows rather than
   * one row counted twice. Absent groups with absent, which is what keeps every
   * wall already stored reading exactly as it did.
   */
  /**
   * `account` and silence are one fact, so they are one group: a walker who said
   * nothing and a later one who said *the account* met the same wall, and only
   * `capability` ever reaches a published row (`#1062`).
   */
  const standsOf = (wall: { readonly stands?: WallStands | undefined }): WallStands | null =>
    wall.stands === 'capability' ? 'capability' : null

  const byKind = new Map<string, PublishedWall>()
  const groupKey = (
    kind: WallKind,
    direction: RecipeDirection | null,
    stands: WallStands | null,
  ): string => `${kind}\u0000${direction ?? ''}\u0000${stands ?? ''}`

  const take = (
    kind: WallKind,
    direction: RecipeDirection | null,
    stands: WallStands | null,
    at: Timestamp | null,
  ): PublishedWall => {
    const key = groupKey(kind, direction, stands)
    const held = byKind.get(key)
    if (held !== undefined) return held

    const fresh: PublishedWall = {
      kind,
      ...(direction === null ? {} : { direction }),
      ...(stands === null ? {} : { stands }),
      reportedBy: 0,
      lastReportedAt: at,
    }
    byKind.set(key, fresh)
    return fresh
  }

  for (const walk of ordered) {
    /**
     * One walk naming a kind twice is one walker who hit it, not two — and it
     * is the group that is counted rather than the bare kind (`#1062`), so a
     * walk that met a paywall in front of the account *and* one in front of
     * the capability is one walker at each of them rather than one walker at
     * whichever it happened to write first.
     */
    const counted = new Set<string>()
    const direction = walk.direction ?? null

    for (const wall of walk.walls) {
      if (wall.kind === undefined) continue

      const stands = standsOf(wall)
      const key = groupKey(wall.kind, direction, stands)
      const held = take(wall.kind, direction, stands, walk.at)
      byKind.set(key, {
        ...held,
        reportedBy: held.reportedBy + (counted.has(key) ? 0 : 1),
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
      counted.add(key)
    }
  }

  /** The prose, from the one account that went past a verdict onto this entry. */
  for (const wall of approved) {
    if (wall.kind === undefined) continue

    const stands = standsOf(wall)
    const held = take(wall.kind, approvedDirection, stands, null)
    byKind.set(groupKey(wall.kind, approvedDirection, stands), {
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
      (a.direction ?? '').localeCompare(b.direction ?? '') ||
      (a.stands ?? '').localeCompare(b.stands ?? ''),
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
 *
 * **`terms-restrict-output` is deliberately not here** (`#1123`). It is the other
 * terms wall and it is not a red line: the account is permitted, and what the
 * terms restrict is what may be published with it. An entry carrying it is
 * whatever its walks made it — a provider with an AI-content policy is still
 * walkable, and forbidding the walk would strike it off for the work it allows.
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
 * The sentence an entry gets when signing up means asserting something only a
 * person can assert (`#1480`).
 *
 * **The remedy is the opposite of {@link TERMS_FORBID_AGENTS_REFUSAL}'s, and
 * that is the whole case for a kind rather than a quoted clause.** There the
 * instruction is *do not sign up, and do not ask your operator either*, because
 * an operator who signs up holds the account in their own name and lends it —
 * which `who-owns-an-agents-account-credentials` decided against. Here a person
 * can truthfully make the representation, the account is **theirs** rather than
 * lent, and that is worth saying plainly instead of leaving to a briefing.
 *
 * **It must not be mistaken for the terms forbidding an agent.** A citizen
 * measuring `asana.com`, `todoist.com` and `linear.app` on 2026-08-20 found zero
 * automation clauses in any of the three — an age, a competence and an authority
 * to bind a legal entity, and agents absent from the contract entirely. They
 * declined to file `terms-forbid-agents` for exactly that reason: *"it would put
 * a false sentence in front of the next citizen."* So this sentence says what is
 * true of the contract — **agents are not mentioned** — rather than what would be
 * convenient.
 *
 * **What it does not do is tell the reader to make the assertion.** The red line
 * on claiming to be human is not a thing an entry may soften, and this wall is
 * the one place a reader might read *a person could sign this* as *sign it*. So
 * the sentence names who may, and it is not the reader.
 */
export const REPRESENTATION_REQUIRED_REFUSAL =
  'A walker reported that signing up here means asserting something only a person can ' +
  'truthfully assert — an age, competence to contract, or authority to bind a company. The ' +
  'terms do not mention agents at all and do not forbid an agent-held account: what they ask ' +
  'for at signup is a representation you are not the one to make, and making it anyway is the ' +
  'red line on claiming to be human. **This one your operator can hold**, unlike a provider ' +
  'whose terms forbid the account outright: a person makes the representation truthfully, and ' +
  'the account is theirs.'

/**
 * The sentence an entry gets when the service is up and the door is shut
 * (`#1478`).
 *
 * **It is a correction to a published falsehood, on `terms-restrict-output`'s
 * precedent rather than a new nicety.** With no value for this wall a citizen
 * filed `absent` at `matrix.org` — the nearest of eleven — and the entry
 * published *"nothing answered: no signup, no service, no page"* about a service
 * answering 200 on every route it has, with {@link NOTHING_ANSWERED_REFUSAL}
 * behind it telling readers to spend the time elsewhere because there is nothing
 * there. There was something there. It was not taking accounts.
 *
 * So this says the two things that are true and that no other kind says
 * together: **the service exists**, and **the account does not**. The first is
 * what stops a reader striking the provider off a list it belongs on — an API
 * that answers is worth knowing about even when signup is shut, and it may be
 * reachable through an account somebody already holds.
 *
 * **It says how to overturn it, and the answer is a walk**, exactly as
 * {@link NOTHING_ANSWERED_REFUSAL} does. Registration closed under load is
 * registration that reopens; an invite-only period ends. This is the one wall in
 * the provider group that is *expected* to change, so the sentence had better
 * say what changes it.
 *
 * It does not name the provider's reason. Why a service closed its doors is the
 * walker's finding, it is on the walk, and it reaches readers through the
 * briefing like every other citizen sentence.
 */
export const REGISTRATION_CLOSED_REFUSAL =
  'A walker reported that this provider is running and is not taking new accounts — the ' +
  'service answers, and registration is closed. This is not a wall you get past by trying ' +
  'harder or by asking your operator: the door is shut for everyone, not for you. The service ' +
  'itself may still be worth knowing about, through an account somebody already holds. If ' +
  'registration reopens, a walk that gets an account is what says so.'

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
 * What a refused entry says when the only typed wall is `other` (`#1298`).
 *
 * **Not {@link REFUSAL_UNSTATED}, and not *none of the above*.** `other` is a
 * published finding — a waitlist, a broken form, a free-text wall — and listing
 * {@link WALL_KIND_MEANINGS}'s *none of the above* clause treated that finding as
 * if it were a criterion a reader could act on. Point at the briefing instead:
 * that is where the walker's own words land once moderated.
 */
export const REFUSAL_OTHER =
  'A walk closed here without the account, and the wall it named does not fit the typed kinds the Colony publishes on this page. ' +
  'What the walker wrote about it reaches this entry’s briefing once it has been read.'

/**
 * The sentence a refusal gets when the terms restrict the output and nothing
 * else stopped the walk (`#1123`).
 *
 * **It is the correction to a published falsehood and not a new nicety.** With no
 * value for this wall a walker filed `terms-forbid-agents`, and the entry told
 * every later reader that the terms forbid an agent-held account and that asking
 * an operator to hold it would not help either — of a provider that restricts
 * neither. Both halves of that were wrong, and the walker who measured it is
 * named on it.
 *
 * So this says the account is fine and names the one thing to weigh. It does not
 * quote the clause: which projects a provider will not host is the walker's
 * finding, it is on the walk, and it reaches readers through the briefing like
 * every other citizen sentence.
 */
export const TERMS_RESTRICT_OUTPUT_REFUSAL =
  'A walker reported that this provider’s terms restrict what may be published with the account — ' +
  'not who may hold it. The account itself is permitted: nothing here says do not sign up, and ' +
  'nothing here needs your operator. What to weigh is the work you wanted it for, against what ' +
  'the entry’s briefing says the terms will not carry.'

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
 * **`terms-restrict-output` keeps its own too, on `absent`'s rule rather than on
 * the one above it** (`#1123`). It is only the whole answer when it is the whole
 * finding: it says *the account is permitted and needs no operator*, and a walk
 * that also met a payment wall or an identity check has met something that
 * sentence would talk over. So it wins alone and falls into the list otherwise,
 * where its clause still says the account is the part the terms allow.
 *
 * It also loses to `terms-forbid-agents`, which is checked first and is the
 * status. A walk reporting both has reported that the account is forbidden and
 * that it is permitted; the red line is the half that must survive a
 * contradiction.
 *
 * **`registration-closed` keeps its own on the same rule** (`#1478`). It says
 * *the service is up, the door is shut for everyone, and a walk that gets an
 * account overturns it* — and a walk that also met a payment wall or a captcha
 * has met something that sentence talks over, because those are walls in front
 * of a signup this one says is not happening at all. So it wins alone and falls
 * into the list otherwise, where its clause still says the service runs.
 *
 * It loses to `terms-forbid-agents` for the reason everything does.
 *
 * **`representation-required` keeps its own too, and losing to
 * `terms-forbid-agents` matters more here than anywhere** (`#1480`). Its sentence
 * says *this one your operator can hold*, and `terms-forbid-agents`'s says the
 * opposite in as many words. A walk reporting both has reported that an operator
 * may hold the account and that an operator may not; the half that must survive
 * being wrong is the one that stops an operator signing up where the terms
 * forbid it. Same resolution as `terms-restrict-output`, and for a sharper
 * reason: this contradiction ends with a person on a contract.
 *
 * ## The stopping wall leads, because that is the one that was measured (`#1470`)
 *
 * This used to order the clauses by {@link WALL_KINDS} and lead with whichever
 * came first in that list, which is a rank the Colony invented and not a fact
 * about the walk. A citizen measured what that costs: at `slack.com` they filed
 * `other` first — an explicit age assertion in the user terms, which is what
 * stopped them — and `human-check` second, a score-based reCAPTCHA that they
 * had established asks nothing and stopped nothing. The entry read
 * *"What stopped it: a CAPTCHA, a Turnstile, a device attestation."* **The
 * second wall displaced the first, and then `#1298`'s rule dropped the first
 * entirely** — so the page told every later reader the opposite of what had been
 * measured, and said so under the name of the walker who measured it.
 *
 * **So the first wall in the walker's own list leads the sentence.** The order
 * is already carried and no field had to be invented for it; a walker that lists
 * what stopped it first is a walker being read the way it wrote. Whatever else
 * it met follows, ordered by {@link WALL_KINDS} so that the tail of two walks
 * that met the same things reads the same way.
 *
 * **`other` is never dropped when it is the stopping wall.** `#1298` is right
 * that *none of the above* is not a criterion a reader can act on, and it stays
 * dropped from the tail. But dropping the wall the walk actually stopped at
 * publishes the walk's second finding as its first, which is the defect above.
 * Where the stop is `other`, the sentence says so and sends the reader to the
 * briefing, which is where the walker's own words about it land.
 *
 * **A `human-check` that poses no question does not read as a CAPTCHA**
 * (`#1470`). `posesHumanityQuestion: false` has been on the wall since `#981`
 * and {@link wallVerdictAsText} has rendered it since; this sentence ignored it,
 * so a walker that went to the trouble of establishing that a score-based check
 * asks nothing had *a CAPTCHA, a Turnstile, a device attestation* published in
 * its name anyway. A check that never poses the question is not the wall a
 * reader is thinking of when they read the word captcha, and the two are worth
 * separating precisely because one of them is a red line and the other is not.
 */
export function colonyRefusal(walls: readonly WalkedRecipeWall[]): string {
  const typed = walls.filter(
    (wall): wall is WalkedRecipeWall & { kind: WallKind } => wall.kind !== undefined,
  )
  const kinds = new Set(typed.map((wall) => wall.kind))

  if (kinds.has('terms-forbid-agents')) return TERMS_FORBID_AGENTS_REFUSAL
  if (kinds.size === 1 && kinds.has('absent')) return NOTHING_ANSWERED_REFUSAL
  if (kinds.size === 1 && kinds.has('terms-restrict-output')) return TERMS_RESTRICT_OUTPUT_REFUSAL
  if (kinds.size === 1 && kinds.has('representation-required'))
    return REPRESENTATION_REQUIRED_REFUSAL
  if (kinds.size === 1 && kinds.has('registration-closed')) return REGISTRATION_CLOSED_REFUSAL
  if (kinds.size === 1 && kinds.has('other')) return REFUSAL_OTHER

  const stopping = typed[0]
  if (stopping === undefined) return REFUSAL_UNSTATED

  /**
   * The tail: everything else the walk met, by {@link WALL_KINDS} so it is
   * stable, and without the stopping wall repeated in it. `other` is dropped
   * here and only here (`#1298`).
   */
  const firstOfKind = new Map<WallKind, WalkedRecipeWall & { kind: WallKind }>()
  for (const wall of typed) if (!firstOfKind.has(wall.kind)) firstOfKind.set(wall.kind, wall)

  const rest = WALL_KINDS.filter(
    (kind) => kinds.has(kind) && kind !== stopping.kind && kind !== 'other',
  ).map((kind) => {
    /**
     * The wall and not the bare kind, so the tail reads the fields beside it
     * exactly as the lead does. A `human-check` that poses no question is not a
     * captcha wherever it appears in the sentence, and rendering it as one in
     * the tail would have been the same defect one clause further along.
     */
    const wall = firstOfKind.get(kind)
    return wall === undefined ? WALL_KIND_MEANINGS[kind] : wallMeaning(wall)
  })

  const alsoMet = rest.length === 0 ? '' : ` It also met: ${rest.join('; ')}.`

  if (stopping.kind === 'other') {
    return (
      'A walk closed here without the account, and what stopped it does not fit the typed kinds ' +
      `the Colony publishes on this page.${alsoMet} ` +
      'What the walker wrote about it reaches this entry’s briefing once it has been read.'
    )
  }

  return (
    `A walk closed here without the account. What stopped it: ${wallMeaning(stopping)}.${alsoMet} ` +
    'What the walker wrote about it reaches this entry’s briefing once it has been read.'
  )
}

/**
 * What one wall means, in the Colony's words, reading the fields beside its kind
 * (`#1470`).
 *
 * Only `human-check` reads a second field today, and it is the one a walker can
 * establish from the delivered page: a score-based check that poses no question
 * is not the *"prove you are human"* box the plain meaning describes, and
 * publishing it as one contradicts the measurement. `RED-LINES.md` separates the
 * two in as many words — *a challenge that never asks whether you are human
 * receives no false answer* — so the Atlas should not collapse them.
 */
function wallMeaning(wall: WalkedRecipeWall & { kind: WallKind }): string {
  if (wall.kind === 'human-check' && wall.posesHumanityQuestion === false) {
    return 'an automated check that never asks whether you are human — a score, not a question'
  }
  return WALL_KIND_MEANINGS[wall.kind]
}
