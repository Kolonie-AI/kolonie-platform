import { and, asc, desc, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm'
import {
  AccountKindSchema,
  AccountProviderSchema,
  AgentPlatformSchema,
  atlasCategoryForKind,
  colonyRefusal,
  publishWalls,
  RecipeActorSchema,
  RecipeDirectionSchema,
  TERMS_FORBID_AGENTS_REFUSAL,
  WalkOutcomeSchema,
  WalkProseSchema,
  wallsForbidWalking,
  WALK_PROSE_COLUMNS,
  WALK_PUBLISHED_REPUTATION,
  WalkedRecipeSchema,
  walkHasProse,
  walkIsReported,
  walkProse,
  walkVerdict,
  type AccountKind,
  type AccountWalk,
  type AgentId,
  type AgentPlatform,
  type AtlasCategory,
  type ProviderRecipe,
  type ProviderTerms,
  type RecipeDirection,
  type RecipeOperatorGuess,
  type SignupCost,
  type WalkOutcome,
  type WalkProse,
  type WalkVerdict,
  type WalkedRecipe,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { accountWalks, accountWalkSteps } from '../schema/account-walks.js'
import { agents } from '../schema/agents.js'
import { providerRecipes as providerRecipesTable } from '../schema/provider-recipes.js'
import { canonicalProvider } from './atlas-renames.js'
import { currentSessionStartSql } from './sessions.js'
import { markProviderBriefingStale } from './provider-briefing.js'
import { providerRecipe, recordMeasuredProvider, writeProviderRecipe } from './provider-recipes.js'
import { toTimestamp } from './rows.js'

/**
 * Walks, as they happen and as they are read back (`#601`).
 *
 * **Every function here is called from where the thing actually happens** — a
 * handoff opening, an account being declared — rather than from a reporting
 * step at the end. That is what makes the record observed rather than narrated,
 * which is the distinction `#601` draws and the reason an agent is asked one
 * question and not handed a form.
 */

type WalkRow = typeof accountWalks.$inferSelect
type StepRow = typeof accountWalkSteps.$inferSelect

function toWalk(walk: WalkRow, steps: readonly StepRow[]): AccountWalk {
  return {
    id: walk.id,
    agentId: walk.agentId,
    kind: AccountKindSchema.parse(walk.kind),
    provider: AccountProviderSchema.parse(walk.provider),
    startedAt: toTimestamp(walk.startedAt),
    finishedAt: walk.finishedAt === null ? null : toTimestamp(walk.finishedAt),
    outcome: walk.outcome === null ? null : WalkOutcomeSchema.parse(walk.outcome),
    wall: walk.wall,
    note: walk.note,
    did: walk.did,
    broke: walk.broke,
    changed: walk.changed,
    discarded: walk.discarded,
    takenStepPositions: walk.takenStepPositions,
    /** Parsed on the way out, like every other `jsonb` here: the column is not a shape. */
    recipe: walk.recipe === null ? null : WalkedRecipeSchema.parse(walk.recipe),
    direction: walk.direction === null ? null : RecipeDirectionSchema.parse(walk.direction),
    steps: steps
      .map((step) => ({
        position: step.position,
        actor: RecipeActorSchema.parse(step.actor),
        secret: step.secret,
        ...(step.ask === null ? {} : { ask: step.ask }),
        at: toTimestamp(step.at),
      }))
      .sort((one, two) => one.position - two.position),
  }
}

/**
 * The walk an agent is currently on for this provider, opening one if there is
 * none.
 *
 * **Get-or-open and never open**, and that is what makes this callable from
 * four places without any of them having to know whether it is first. A handoff
 * can be the first thing that happens or the third; `accounts.declare` can be
 * the only thing that happens, for a provider an agent joined unaided. Each
 * call site records what it saw and none of them owns the lifecycle.
 *
 * **One open walk per agent per provider.** A second concurrent walk of the same
 * provider by the same citizen is not a thing that happens — an agent holds one
 * session — and treating it as one would split a walk in half down the middle,
 * which is worse than either outcome of assuming it does not.
 */
export async function openWalkId(
  db: Database,
  agentId: AgentId,
  input: { readonly kind: AccountKind; readonly provider: string },
): Promise<string | undefined> {
  const [open] = await db
    .select({ id: accountWalks.id })
    .from(accountWalks)
    .where(
      and(
        eq(accountWalks.agentId, agentId),
        eq(accountWalks.kind, input.kind),
        eq(accountWalks.provider, await canonicalProvider(db, input.provider)),
        isNull(accountWalks.finishedAt),
      ),
    )
    .orderBy(desc(accountWalks.startedAt))
    .limit(1)

  return open?.id
}

export async function walkInProgress(
  db: Database,
  agentId: AgentId,
  input: { readonly kind: AccountKind; readonly provider: string },
): Promise<string> {
  /**
   * **One walk per provider, whichever of its names the agent typed** (`#772`).
   *
   * Resolved here rather than at each call site because there are three of them
   * — a declaration, a sealed handoff and an ordinary one — and the fourth one
   * somebody adds would be the one that opened a second walk on the same
   * afternoon's work. The storage layer owns the key; this is where the key is
   * decided.
   */
  const provider = await canonicalProvider(db, AccountProviderSchema.parse(input.provider))

  /**
   * **Read before write, and the read is its own function** (`#601`). Reporting
   * a walk has to be able to ask *is one open* without opening one — an agent
   * that reports a walk it never started must be told so, not handed an empty
   * record it just created.
   */
  const existing = await openWalkId(db, agentId, input)
  if (existing !== undefined) return existing

  const [row] = await db
    .insert(accountWalks)
    .values({ agentId, kind: input.kind, provider })
    .returning({ id: accountWalks.id })

  if (row === undefined) throw new Error('account_walks insert returned no row')

  return row.id
}

/**
 * Record that something happened, at the moment it happens.
 *
 * **The position is counted here rather than supplied**, so no caller can
 * renumber a walk it is halfway through. What is being recorded is the order
 * things occurred in, and the only thing that knows that is the row count at
 * the moment of writing.
 *
 * A walk longer than `RECIPE_MAX_STEPS` stops recording rather than failing:
 * the twenty-first step of a signup is a finding about the provider, and losing
 * the walk over it would be the record refusing the case it most wants.
 */
export async function recordWalkStep(
  db: Database,
  walkId: string,
  step: {
    readonly actor: 'agent' | 'operator'
    readonly secret?: boolean
    /** The ask the Colony sent, on an operator step. Never composed here. */
    readonly ask?: string | null
  },
): Promise<void> {
  const [{ taken = 0 } = {}] = await db
    .select({ taken: sql<number>`cast(count(*) as integer)` })
    .from(accountWalkSteps)
    .where(eq(accountWalkSteps.walkId, walkId))

  if (taken >= 20) return

  await db.insert(accountWalkSteps).values({
    walkId,
    position: taken + 1,
    actor: step.actor,
    secret: step.secret ?? false,
    ask: step.actor === 'operator' ? (step.ask ?? null) : null,
  })
}

/** One walk, whole, or nothing. */
export async function accountWalk(db: Database, walkId: string): Promise<AccountWalk | undefined> {
  const [walk] = await db.select().from(accountWalks).where(eq(accountWalks.id, walkId)).limit(1)
  if (walk === undefined) return undefined

  const steps = await db
    .select()
    .from(accountWalkSteps)
    .where(eq(accountWalkSteps.walkId, walkId))
    .orderBy(asc(accountWalkSteps.position))

  return toWalk(walk, steps)
}

/** One citizen's walk, without revealing whether the id belongs to somebody else. */
export async function ownAccountWalk(
  db: Database,
  agentId: AgentId,
  walkId: string,
): Promise<AccountWalk | undefined> {
  const [walk] = await db
    .select()
    .from(accountWalks)
    .where(and(eq(accountWalks.id, walkId), eq(accountWalks.agentId, agentId)))
    .limit(1)
  if (walk === undefined) return undefined

  const steps = await db
    .select()
    .from(accountWalkSteps)
    .where(eq(accountWalkSteps.walkId, walkId))
    .orderBy(asc(accountWalkSteps.position))

  return toWalk(walk, steps)
}

/** A citizen's walks, newest first, for private status reads. */
export async function accountWalkList(
  db: Database,
  agentId: AgentId,
  kind?: AccountKind,
): Promise<readonly AccountWalk[]> {
  const rows = await db
    .select()
    .from(accountWalks)
    .where(
      kind === undefined
        ? eq(accountWalks.agentId, agentId)
        : and(eq(accountWalks.agentId, agentId), eq(accountWalks.kind, kind)),
    )
    .orderBy(desc(accountWalks.startedAt))

  return Promise.all(
    rows.map(async (row) => {
      const steps = await db
        .select()
        .from(accountWalkSteps)
        .where(eq(accountWalkSteps.walkId, row.id))
        .orderBy(asc(accountWalkSteps.position))

      return toWalk(row, steps)
    }),
  )
}

/**
 * The last walk here that did not get through and never said why (`#811`).
 *
 * **The newest one only, and never a queue of them.** What the Academy gates is
 * *the next attempt after the one you did not report* — a citizen that owes
 * three reports at a provider owes the sentence about the last of them, and a
 * gate that demanded all three would be a debt collector rather than a prompt.
 *
 * `proved` is excluded in SQL rather than filtered afterwards: the walk that got
 * through is never asked, and that has to be true of the query so that a citizen
 * holding an account cannot be held up by a row nobody reads.
 */
export async function unreportedWalk(
  db: Database,
  agentId: AgentId,
  where: { readonly kind: AccountKind; readonly provider: string },
): Promise<AccountWalk | undefined> {
  const provider = await canonicalProvider(db, where.provider)

  const [row] = await db
    .select()
    .from(accountWalks)
    .where(
      and(
        eq(accountWalks.agentId, agentId),
        eq(accountWalks.kind, where.kind),
        eq(accountWalks.provider, provider),
        isNotNull(accountWalks.finishedAt),
        ne(accountWalks.outcome, 'proved'),
        /**
         * A walk opened and closed by `walk-report` in one transaction was
         * reported by construction. `now()` is transaction-stable, so equal
         * endpoints distinguish it without adding a column solely for its origin.
         */
        sql`${accountWalks.startedAt} <> ${accountWalks.finishedAt}`,
      ),
    )
    .orderBy(desc(accountWalks.finishedAt))
    .limit(1)

  if (row === undefined) return undefined

  const walk = toWalk(row, [])

  return walkIsReported(walk) ? undefined : walk
}

/**
 * Write the report onto a walk that was already closed (`#811`).
 *
 * **The gate would be a trap without this.** A walk is closed by the report, so
 * a walk closed *without* one can no longer be reported through the ordinary
 * path — `finishWalk` refuses a second close, correctly, because a second close
 * would write a second entry. This writes the answers and nothing else: no
 * outcome, no verdict, no catalogue write.
 *
 * **It cannot overwrite an answer**, which is what keeps it from being an edit
 * surface for testimony: it applies only where the walk holds none, and a walk
 * that already said something is left exactly as it is.
 */
export async function reportFinishedWalk(
  db: Database,
  agentId: AgentId,
  walkId: string,
  answers: {
    readonly note?: string | null
    readonly did?: string | null
    readonly broke?: string | null
    readonly changed?: string | null
    readonly discarded?: string | null
  },
): Promise<AccountWalk | undefined> {
  const [updated] = await db
    .update(accountWalks)
    .set({
      note: answers.note ?? null,
      did: answers.did ?? null,
      broke: answers.broke ?? null,
      changed: answers.changed ?? null,
      discarded: answers.discarded ?? null,
      /**
       * **Re-queued, including a wall something already read** (`#810`). This
       * writes four answers onto a walk that may have been closed with a wall and
       * approved on the strength of it; approving the page again from the verdict
       * that covered one sixth of it would serve four sentences nothing looked
       * at. The scrub is thrown away with it, because a scrub of a shorter page
       * is not a scrub of this one.
       */
      ...(walkHasProse(walkProse(answers))
        ? { proseStatus: 'pending' as const, scrubbedProse: null }
        : {}),
    })
    .where(
      and(
        eq(accountWalks.id, walkId),
        eq(accountWalks.agentId, agentId),
        isNotNull(accountWalks.finishedAt),
        isNull(accountWalks.note),
        isNull(accountWalks.did),
        isNull(accountWalks.broke),
        isNull(accountWalks.changed),
        isNull(accountWalks.discarded),
      ),
    )
    .returning()

  if (updated === undefined) return undefined

  const steps = await db
    .select()
    .from(accountWalkSteps)
    .where(eq(accountWalkSteps.walkId, walkId))
    .orderBy(asc(accountWalkSteps.position))

  return toWalk(updated, steps)
}

/**
 * Recount what stopped walkers at one provider, and write it on the entry
 * (`#981`).
 *
 * **Called where a walk changes, not where the catalogue is read.** The Atlas is
 * read far more often than it is walked, and a group-by over every walk at every
 * provider on a hot path would be paid for by every reader to serve the one write
 * a week that moves it. So this runs inside the transaction that closes or amends
 * a walk, and `toRecipe` reads a column.
 *
 * **The typed half is computed from every walk; the prose comes only from the
 * account the entry already publishes.** That is `#981` section 4 — a kind, a
 * count, a boolean and a number publish unmoderated because none of them can leak
 * a credential or carry a grudge, and `title`, `symptom` and `remedy` wait for the
 * same verdict every other sentence in the Atlas waits for.
 *
 * @param at the provider, already canonical. Callers here have resolved it.
 */
async function republishWalls(
  tx: Transaction,
  at: { readonly kind: AccountKind; readonly provider: string },
): Promise<void> {
  const [entry] = await tx
    .select()
    .from(providerRecipesTable)
    .where(
      and(eq(providerRecipesTable.kind, at.kind), eq(providerRecipesTable.provider, at.provider)),
    )
    .limit(1)

  if (entry === undefined) return

  const walked = await tx
    .select({
      id: accountWalks.id,
      finishedAt: accountWalks.finishedAt,
      recipe: accountWalks.recipe,
      direction: accountWalks.direction,
    })
    .from(accountWalks)
    .where(
      and(
        eq(accountWalks.kind, at.kind),
        eq(accountWalks.provider, at.provider),
        isNotNull(accountWalks.finishedAt),
        isNotNull(accountWalks.recipe),
      ),
    )

  const walls = publishWalls(
    walked.flatMap((walk) => {
      /** Parsed on the way out, like everywhere else a `jsonb` becomes a shape. */
      const recipe = walk.recipe === null ? null : WalkedRecipeSchema.parse(walk.recipe)
      if (recipe?.walls === undefined || walk.finishedAt === null) return []
      return [
        {
          walkId: walk.id,
          at: toTimestamp(walk.finishedAt),
          /**
           * **Which capability the walker was measuring** (`#1036`). Null on
           * every kind with no axis, which is what `publishWalls` groups the
           * whole catalogue on today and what every walk closed before `#1023`
           * carries.
           */
          direction: walk.direction === null ? null : RecipeDirectionSchema.parse(walk.direction),
          walls: recipe.walls,
        },
      ]
    }),
    (entry.walkedRecipe === null ? null : WalkedRecipeSchema.parse(entry.walkedRecipe))?.walls ??
      [],
    /**
     * The prose lands on the wall the account it came from describes — which is
     * the entry's own scope, because the entry publishes exactly one walker's
     * account and `writeProviderRecipe` set both from the same walk.
     */
    entry.direction === null ? null : RecipeDirectionSchema.parse(entry.direction),
  )

  /**
   * **`terms-forbid-agents` is the verdict and not a note beside it** (`#981`
   * section 3). An entry whose terms forbid an agent holding the account is
   * `refused`, and computing that from the wall is what stops the two disagreeing.
   *
   * **It never deletes anything to get there.** A published entry with steps
   * cannot legally become `refused` — `provider_recipes_unjoinable_is_empty`
   * requires a refusal to carry no steps and prove nothing — so honouring the rule
   * there would mean erasing a steward's recipe on one citizen's unmoderated
   * report, which is a vandalism route and not a classification. So the status
   * moves only where nothing is under it to lose, and an entry with steps keeps
   * them and carries the wall. See the note on `#981`: which of the two the
   * maintainer wants is the one thing that specification does not settle.
   */
  const forced =
    wallsForbidWalking(walls) &&
    entry.status !== 'refused' &&
    entry.status !== 'retired' &&
    entry.steps.length === 0 &&
    entry.proves === null

  await tx
    .update(providerRecipesTable)
    .set({
      walls,
      updatedAt: sql`now()`,
      ...(forced ? { status: 'refused' as const, refusal: TERMS_FORBID_AGENTS_REFUSAL } : {}),
    })
    .where(
      and(eq(providerRecipesTable.kind, at.kind), eq(providerRecipesTable.provider, at.provider)),
    )
}

/**
 * What a walk says about the money and the terms, for the entry it writes (`#983`).
 *
 * **The walker answers, and where it did not the entry keeps what it had.**
 * `writeProviderRecipe` is an upsert whose rule is that an omitted field resets:
 * a curation edit that does not mention `cost` is not re-asserting it. That rule
 * is right for a curator editing a whole entry and wrong for a walk, which is
 * told about two fields and nothing else — and the branch that writes passed
 * neither,
 * so a walk against an entry somebody had already answered blanked both back to
 * `unknown` on its way past.
 *
 * **`unknown` is never written from here.** The walk schema does not accept it,
 * so a walker that did not look leaves the field out and this returns nothing
 * for it, which is what leaves the previous answer standing.
 */
function conditionsFromWalk(
  recipe: WalkedRecipe | null,
  entry: ProviderRecipe | undefined,
): { terms?: ProviderTerms; cost?: SignupCost } {
  const terms = recipe?.terms ?? entry?.terms
  const cost = recipe?.cost ?? entry?.cost

  return {
    ...(terms === undefined ? {} : { terms }),
    ...(cost === undefined ? {} : { cost }),
  }
}

/**
 * What a walk carries forward off the entry it is writing over (`#1032`).
 *
 * **The same argument `conditionsFromWalk` makes, for the fields a walk is not
 * asked about at all.** `writeProviderRecipe` is an upsert and its rule is that
 * an omitted field resets — right for a curator editing a whole entry, and
 * wrong for a walk, which is told about a handful of columns and passes only
 * those. Everything else on the row is somebody's curation: what the provider
 * is, whether it pays for placement, the referral arrangement, the cautions a
 * reader is meant to meet before signing up. A walk closing past it wiped the
 * lot.
 *
 * **`#1032` is why this is worth writing now rather than later.** The write was
 * already reachable for an entry that was `unwritten`, but only a walk that got
 * through reached it; an abandoned walk proposed nothing. Both now write, so
 * every closed walk at a shelved provider passes over whatever a curator put
 * there.
 *
 * **Not `proves`, `provesTask` or `reaches`.** Those three are the joinable
 * entry's, `provider_recipes_unjoinable_is_empty` refuses them on anything this
 * branch writes, and a walk never reaches an entry holding them —
 * `walkVerdict` answers `confirms` or `diverges` against a published route.
 * Carrying them would turn a constraint the row cannot satisfy into a failed
 * write nobody asked for.
 *
 * **The operator guess is read back off what it derived**, because the read
 * shape does not carry the column: `#589` decided the guess is stored and never
 * surfaced, and what a reader gets is `operatorNeed` with `operatorNeedIsGuess`
 * beside it. Both branches here write no steps, so the need on an entry they
 * write over came from the guess or from nowhere — which makes the pair a
 * faithful round trip rather than a reconstruction, and `unknown` the same
 * answer as an unset column.
 */
function curationFromEntry(entry: ProviderRecipe | undefined): {
  about?: string | null
  runtimes?: ProviderRecipe['runtimes']
  paid?: boolean
  referral?: ProviderRecipe['referral']
  contact?: string | null
  operatorGuess?: RecipeOperatorGuess | null
  cautions?: ProviderRecipe['cautions']
  needs?: ProviderRecipe['needs']
  agentApi?: ProviderRecipe['agentApi']
  signupCode?: ProviderRecipe['signupCode']
  pacePerDay?: number | null
} {
  if (entry === undefined) return {}

  return {
    about: entry.about,
    runtimes: entry.runtimes,
    paid: entry.paid,
    referral: entry.referral,
    contact: entry.contact,
    operatorGuess:
      entry.operatorNeedIsGuess && entry.operatorNeed !== 'unknown' ? entry.operatorNeed : null,
    cautions: entry.cautions,
    needs: entry.needs,
    agentApi: entry.agentApi,
    signupCode: entry.signupCode,
    pacePerDay: entry.pacePerDay,
  }
}

/**
 * Replace the walker's own account on the entry it wrote (`#986`).
 *
 * **The one thing on that entry that is the walker's to write.** A citizen read
 * `requiredChanges` off its draft, wrote the whole path out in answer — eight
 * steps, five walls, three verification checks — and had nowhere to put it:
 * `walk-report` answers `not_found` on a walk that closed, correctly, because a
 * second close would write a second entry. So the report was a dead end and
 * the Atlas kept the version it had already said was not good enough.
 *
 * **It touches the account and nothing else.** No outcome, no verdict, no
 * status, no steps: what a finished walk earned was decided when it finished,
 * and the entry's own steps and wording are the Colony's (`#517`, `#601`). What
 * moves is the walker's attributed account, on the walk row.
 *
 * **The corrected account stays on the walk and does not travel to the entry**
 * (`#1032`). It did until this issue, because the entry it landed on was a
 * private `draft`; a `measured` entry is public, so a rewrite arriving here
 * would reach `kolonie.accounts.recipes` unread. `finishWalk` says the whole of
 * that argument. What still travels are the conditions — typed fields a reader
 * cannot be misled by a sentence in.
 *
 * **Only the walk that wrote the entry, and only while the entry is
 * `measured`.** That was `draft` until `#1032` retired the status; `measured`
 * is what a walk writes now, and it is the same gate — an entry standing on
 * what citizens measured rather than on anything the Colony authored.
 * `proposed_at` is stamped on exactly the walk whose verdict wrote the row, so a
 * second citizen walking the same provider cannot overwrite the first one's
 * words, and nothing published is reachable from here at all.
 */
export async function amendMeasuredEntry(
  db: Database,
  agentId: AgentId,
  where: { readonly kind: AccountKind; readonly provider: string },
  recipe: WalkedRecipe,
): Promise<AccountWalk | undefined> {
  const provider = await canonicalProvider(db, where.provider)

  return db.transaction(async (tx) => {
    const entry = await providerRecipe(tx, where.kind, provider)
    if (entry === undefined || entry.status !== 'measured') return undefined

    const [row] = await tx
      .select()
      .from(accountWalks)
      .where(
        and(
          eq(accountWalks.agentId, agentId),
          eq(accountWalks.kind, where.kind),
          eq(accountWalks.provider, provider),
          isNotNull(accountWalks.finishedAt),
          isNotNull(accountWalks.proposedAt),
        ),
      )
      .orderBy(desc(accountWalks.proposedAt))
      .limit(1)

    if (row === undefined) return undefined

    const [updated] = await tx
      .update(accountWalks)
      .set({
        recipe,
        /**
         * **A rewritten route goes back into the queue** (`#1090`). The route is
         * one of the moderated fields now, and this is the one path that edits a
         * moderated field on a walk that has already been judged. Leaving the
         * verdict where it was would publish paragraphs no pass ever read, under
         * an approval earned by the words they replaced — which is the whole of
         * what `prose_status` exists to prevent.
         *
         * The other six go back with it, and that is the honest cost: an
         * amendment is one page rewritten, judged as a page, exactly as
         * `reportFinishedWalk` re-queues a walk that gains the four questions
         * after its wall.
         */
        proseStatus: 'pending' as const,
        scrubbedProse: null,
      })
      .where(eq(accountWalks.id, row.id))
      .returning()

    if (updated === undefined) return undefined

    /**
     * What the briefing currently serves for this pair includes the walk's old
     * words, which are no longer readable. Marking it here is the same argument
     * `recordWalkProseModeration` makes: the place that changes what is readable
     * is the place that has to remember.
     */
    await markProviderBriefingStale(tx, { kind: entry.kind, provider: entry.provider })

    /**
     * **One column, written directly, rather than through
     * `writeProviderRecipe`.** That function is an upsert and it is right to be
     * one: a field it is not told about is reset, because a curation edit that
     * omits `proves` is not re-asserting it. An amendment is the opposite shape
     * — it is told about exactly one field and knows nothing about the rest —
     * so putting it through the upsert would make a walker replacing its own
     * paragraph silently clear whatever a steward had already filled in.
     */
    await tx
      .update(providerRecipesTable)
      .set({
        updatedAt: sql`now()`,
        /**
         * **Written only where the amendment names them** (`#983`), which is the
         * same argument the paragraph above makes about the upsert, one field
         * narrower: a walker correcting its steps has said nothing about the
         * price, and nothing is what its silence should change.
         */
        ...(recipe.terms === undefined ? {} : { terms: recipe.terms }),
        ...(recipe.cost === undefined ? {} : { cost: recipe.cost }),
      })
      .where(
        and(
          eq(providerRecipesTable.kind, entry.kind),
          eq(providerRecipesTable.provider, entry.provider),
        ),
      )

    /** The amendment may have added, dropped or re-qualified a wall (`#981`). */
    await republishWalls(tx, { kind: entry.kind, provider: entry.provider })

    const steps = await tx
      .select()
      .from(accountWalkSteps)
      .where(eq(accountWalkSteps.walkId, row.id))
      .orderBy(asc(accountWalkSteps.position))

    return toWalk(updated, steps)
  })
}

type WalkFinishInput = {
  readonly outcome: WalkOutcome
  /** Required when the outcome is `refused`, refused otherwise. */
  readonly wall?: string | null
  /** The answer to the one question, already checked against `WalkNoteSchema`. */
  readonly note?: string | null
  /**
   * The four questions (`#809`), each already checked against
   * `WalkNoteSchema` — the same bound and the same credential refusal the note
   * is held to, applied per field rather than copied.
   */
  readonly did?: string | null
  readonly broke?: string | null
  readonly changed?: string | null
  readonly discarded?: string | null
  /** Published recipe positions checked by the agent, in order. */
  readonly takenStepPositions?: readonly number[] | null
  /** The walker's own long-form account of the path (`#769`), where it gave one. */
  readonly recipe?: WalkedRecipe | null
  /**
   * Which capability the walk measured (`#1023`), on a kind that has two.
   *
   * Required at the door for a directional kind and refused elsewhere — the
   * refinement is one layer up, where `kind` is, exactly as
   * `ProviderReportRequestSchema` does it. Absent here is the unscoped null.
   */
  readonly direction?: RecipeDirection | null
  /**
   * Whether this is a converted provider verdict rather than a described walk
   * (`#1036`).
   *
   * Absent everywhere except the retiring `kolonie.accounts.provider-report`
   * alias, which is the point: the column is what lets a briefing say *one
   * walker described this and eight filed a verdict* instead of calling nine
   * thin records nine accounts.
   */
  readonly fromProviderReport?: boolean
}

/**
 * Close a walk and do to the catalogue whatever the walk earns.
 *
 * **One function, in one transaction, because the two halves must not be able
 * to disagree.** A walk marked `proved` whose entry was not written is a record
 * saying a recipe exists where none does; an entry written from a walk that was
 * never closed is a recipe derived from a path that may still be running.
 *
 * **What happens is `walkVerdict`'s decision and not this function's.** The
 * table of outcomes lives in `packages/core/src/account/walk.ts` beside the
 * argument for each row; this applies it. A second implementation of *what does
 * a finished walk mean* is a second answer to it.
 *
 * **Nothing here writes a route, and that is what `#1032` changed.** This branch
 * wrote a `draft` — the walk's own steps, held behind a status the public read
 * past until a curator dressed them. It now writes a `measured` row with no steps
 * at all, and the route the citizen took is published in that provider's
 * briefing, out of `account_walks`, under its own author. A divergence is still
 * returned rather than written over what somebody published, so `#600`'s rule is
 * unchanged: what the Colony says about somebody else's product passes a
 * person.
 */
export async function finishWalk(
  db: Database | Transaction,
  walkId: string,
  input: WalkFinishInput,
): Promise<{ readonly walk: AccountWalk; readonly verdict: WalkVerdict } | undefined> {
  return db.transaction(async (tx) => {
    const [closed] = await tx
      .update(accountWalks)
      .set({
        finishedAt: sql`now()`,
        outcome: input.outcome,
        wall: input.outcome === 'refused' ? (input.wall ?? null) : null,
        note: input.note ?? null,
        did: input.did ?? null,
        broke: input.broke ?? null,
        changed: input.changed ?? null,
        discarded: input.discarded ?? null,
        takenStepPositions: input.takenStepPositions == null ? null : [...input.takenStepPositions],
        recipe: input.recipe ?? null,
        direction: input.direction ?? null,
        fromProviderReport: input.fromProviderReport ?? false,
        scrubbedProse: null,
        /**
         * **A walk that wrote something enters the queue as it closes** (`#810`).
         *
         * Here rather than in a sweep that looks for unqueued rows, for
         * `divergentWalks`' converse reason: a flag set at the moment the words
         * are written cannot miss one, where a sweep silently empties the day it
         * stops running. A walk that wrote nothing keeps the column's `approved`
         * default and is never in a queue — there is nothing to read.
         */
        proseStatus: walkHasProse(
          walkProse({ ...input, wall: input.outcome === 'refused' ? (input.wall ?? null) : null }),
        )
          ? 'pending'
          : 'approved',
      })
      .where(and(eq(accountWalks.id, walkId), isNull(accountWalks.finishedAt)))
      .returning()

    /**
     * **Already finished is not an error and writes nothing twice.** The
     * `is null` above is what makes closing a walk idempotent: a retried call,
     * or a proof arriving after a declaration already closed it, must not
     * write a second entry.
     */
    if (closed === undefined) return undefined

    const steps = await tx
      .select()
      .from(accountWalkSteps)
      .where(eq(accountWalkSteps.walkId, walkId))
      .orderBy(asc(accountWalkSteps.position))

    const walk = toWalk(closed, steps)
    const entry = await providerRecipe(tx, walk.kind, walk.provider)

    const verdict = walkVerdict(walk, entry)

    /**
     * The shelf this walk's entry would go on, or nothing (`#917`).
     *
     * **A kind with no shelf writes no entry rather than defaulting to one**,
     * which is the rule `measuredOnlyRecipes` and `recordMeasuredProvider`
     * already follow and the one this path was missing. `atlasCategoryForKind`
     * throws by design — a guessed shelf is a false catalogue claim — and the
     * throw was landing inside the transaction that closes the walk, so an
     * unmappable kind did not lose its entry, it lost the whole
     * `accounts.walk-report` call. The citizen's account of how it joined was
     * refused for a reason it could do nothing about, on the one channel the
     * Atlas depends on.
     *
     * An existing entry's shelf still wins, unchanged: a walk against something
     * somebody already catalogued does not re-shelve it.
     */
    const shelf = ((): AtlasCategory | undefined => {
      if (entry !== undefined) return entry.category
      try {
        return atlasCategoryForKind(walk.kind)
      } catch {
        return undefined
      }
    })()

    if (verdict.kind === 'writes' && shelf !== undefined) {
      await writeProviderRecipe(tx, {
        kind: walk.kind,
        provider: walk.provider,
        /**
         * **The provider's own name and nothing invented.** A title is prose and
         * the Colony writes it; until then the entry is called what it is. The
         * existing title is kept where there is one, so a walk against an entry
         * somebody already named does not rename it.
         */
        title: entry?.title ?? walk.provider,
        category: shelf,
        /**
         * **`measured`, and no route** (`#1032`).
         *
         * This branch used to write `draft`: the walk's own steps became the
         * catalogue's steps, hidden behind a status the public read past until a
         * steward dressed them. Two stewards existed and two Atlas decisions
         * were ever taken, so the gate was a queue nobody emptied and six walks
         * sat behind it. What the Colony publishes here now is the fact it can
         * stand behind — this pair exists, somebody got through — and the route
         * that citizen actually took is published in the provider's briefing,
         * out of `account_walks`, under its own author.
         */
        status: 'measured',
        /**
         * **The entry is a verdict about whatever the walk measured** (`#1023`).
         *
         * An entry derived from a walk that says it went for `inbound` is an
         * entry about inbound, and saying so is the whole of what the axis
         * buys: it is what stops the next citizen sent to earn `phone` reading
         * a sending refusal as *this provider is closed*. A walk with no
         * direction writes `null`, which `directionAnswers` reads as covering
         * both — the conservative reading, and never a guess.
         */
        direction: walk.direction,
        /** No route: see `status` above (`#1032`). */
        steps: [],
        /**
         * **What a walk does not write is the walker's long form** (`#1032`).
         *
         * `#769` put `walkedRecipe` here, and the safety was structural: a walk
         * closed into a `draft` entry, `draft` was private until a steward
         * published it, and the walked recipe had a moderator of its own — the
         * pass `#813` built, which this issue retires. A `measured` entry is
         * public the moment it is written, so the same line would now hand
         * unchecked citizen prose to `kolonie.accounts.recipes` in the request
         * that wrote it.
         *
         * The walker's words are not lost and are not delayed by a person: the
         * six prose columns on the walk are moderated where every other citizen
         * report is, and reach readers through the synthesised briefing
         * (`#831`). What publishes immediately is the typed half — wall kinds,
         * counts, platforms, band — which cannot carry a sentence.
         *
         * A curator may still put a walked recipe on an entry; that is `#600`'s
         * rule, that what the Colony says about somebody else's product passes a
         * person, and it is a different act from a walk closing.
         */
        ...curationFromEntry(entry),
        ...conditionsFromWalk(walk.recipe, entry),
      })

      /**
       * **Who proposed the entry, recorded where it becomes true** (`#858`).
       *
       * On `prose_status`' argument thirty lines up, for the same reason: this
       * is the only moment the fact exists. `provider_recipes` carries no author
       * column and deliberately does not — an entry is the Colony's sentence,
       * not a byline — so a sweep asked later *which walk proposed this* would
       * be guessing from timestamps, and would guess wrong the first time two
       * citizens walked one provider in an afternoon.
       *
       * It also carries `#858`'s *previously had no steps* half for free.
       * `walkVerdict` reaches this branch only where the entry is absent,
       * unwritten or measured; a walk against something the Colony publishes
       * confirms or diverges, and neither is stamped.
       */
      await tx
        .update(accountWalks)
        .set({ proposedAt: sql`now()` })
        .where(eq(accountWalks.id, walkId))
    }

    if (verdict.kind === 'refusal' && shelf !== undefined) {
      await writeProviderRecipe(tx, {
        kind: walk.kind,
        provider: walk.provider,
        title: entry?.title ?? walk.provider,
        category: shelf,
        status: 'refused',
        /**
         * **The Colony's sentence, composed from the typed walls — never the
         * walker's** (`#1032`). This line wrote `verdict.wall`, which is the
         * citizen's own free text and one of `WALK_PROSE_FIELDS`; a `refused`
         * entry is public the moment it is written and `prose_status` is
         * `pending` for every walk closing here, so the words went into
         * `kolonie.accounts.recipes` in the request that wrote them, unread.
         * Same argument as the `writes` branch above, and the walker's account
         * reaches readers the same way: moderated, through the briefing.
         */
        refusal: colonyRefusal(walk.recipe?.walls ?? []),
        /** The direction the branch above carries, and for the same reason (`#1023`). */
        direction: walk.direction,
        steps: [],
        /** No long form here either, and for the reason the branch above gives (`#1032`). */
        ...curationFromEntry(entry),
        ...conditionsFromWalk(walk.recipe, entry),
      })
    }

    /**
     * **The two columns `#601` names as written by nothing.**
     * `confirmProviderRecipe` has existed since `#525` and had no caller; this
     * is it. A walk that matched the published shape is the only thing that
     * should ever move that date — which is why a curation edit does not, and
     * why this is here rather than in `writeProviderRecipe`.
     */
    if (verdict.kind === 'confirms') {
      await tx
        .update(providerRecipesTable)
        .set({ lastConfirmedAt: sql`now()`, lastConfirmedBy: walk.agentId })
        .where(
          and(
            eq(providerRecipesTable.kind, walk.kind),
            eq(providerRecipesTable.provider, walk.provider),
          ),
        )
    }

    /**
     * **A walk that followed an entry and did not get through marks it stale**
     * (`#525`, carried across by `#1036`).
     *
     * `reportProvider` did this, on the argument that the report an agent
     * already files is the report — and folding that surface into this one would
     * have retired the rule by accident, exactly as it nearly retired `#904`'s
     * below. A citizen that walked a published recipe and ended at a wall is the
     * strongest evidence there is that the recipe has gone out of date, and the
     * catalogue has to stop presenting it as current.
     *
     * **Only where the walk ended without the account.** A `proved` walk that
     * took a different route is a divergence and is answered as one; clearing
     * the confirmation there would mark an entry stale for having been walked
     * successfully. And it clears the confirmation rather than setting a flag,
     * so `isStale` reads it exactly as it reads *never confirmed*.
     */
    if (entry !== undefined && (walk.outcome === 'refused' || walk.outcome === 'abandoned')) {
      await tx
        .update(providerRecipesTable)
        .set({ lastConfirmedAt: null, lastConfirmedBy: null })
        .where(
          and(
            eq(providerRecipesTable.kind, walk.kind),
            eq(providerRecipesTable.provider, walk.provider),
          ),
        )
    }

    /**
     * **A walk that proposed nothing still puts the provider on the shelf**
     * (`#904`, carried across by `#1036`).
     *
     * An abandoned walk writes no entry and no refusal, so neither branch
     * above writes anything — and until `provider-report` folded into this
     * surface that was somebody else's job: `reportProvider` created the
     * `measured` row for exactly this case. Folding the two without this line
     * would have retired `#904`'s rule by accident, and a provider a citizen
     * abandoned would go back to reading as one nobody had been to.
     *
     * `onConflictDoNothing` inside, so an entry that already exists is untouched
     * — a measurement never demotes something somebody catalogued.
     */
    if (entry === undefined && verdict.kind !== 'writes' && verdict.kind !== 'refusal') {
      await recordMeasuredProvider(tx, { kind: walk.kind, provider: walk.provider })
    }

    /**
     * **Last, and whatever the verdict was** (`#981`). A walk that merely
     * confirmed the published shape still hit walls on the way — the price, the
     * check, the review — and those are the same fact whether or not the steps
     * matched. Running this after the branches above is what lets it count the
     * entry this walk has only just created.
     */
    await republishWalls(tx, { kind: walk.kind, provider: walk.provider })

    return { walk, verdict }
  })
}

/**
 * File a walk whether or not another account operation opened it first (`#1031`).
 *
 * **The report is itself enough evidence that an attempt happened.** A wall can
 * stop the attempt before the Colony observes a handoff or an account declaration,
 * so requiring either one discards exactly the walks the Atlas most needs.
 *
 * A prior finished report at the same pair is reused rather than multiplied, and
 * that includes one with observed steps (`#1060`).
 *
 * **The steps and the prose are two different things and only one of them is the
 * author's** — which is what the first version of this got wrong. The steps are
 * what the Colony observed happening; the prose, the outcome, the wall and the
 * direction are what the author was asked for and what the surface already
 * promises they can replace. So the reuse leaves `account_walk_steps` alone and
 * overwrites nothing but the reported fields.
 *
 * Refusing a stepped row made `#1023`'s `direction` unreachable on exactly the
 * walks it was written for: a walk opened by `kolonie.accounts.declare` has a
 * step from that moment, so every walk filed the ordinary way was frozen the
 * instant it finished.
 *
 * `rewardedAt` stays the hard stop. A paid row is immutable because a ledger
 * event already refers to what it earned.
 */
export async function submitWalkReport(
  db: Database,
  agentId: AgentId,
  where: { readonly kind: AccountKind; readonly provider: string },
  input: WalkFinishInput,
): Promise<{ readonly walk: AccountWalk; readonly verdict: WalkVerdict } | undefined> {
  return db.transaction(async (tx) => {
    /** Serialize two direct reports from one citizen before either can insert. */
    await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId)).for('update')

    const provider = await canonicalProvider(tx, AccountProviderSchema.parse(where.provider))
    const pair = and(
      eq(accountWalks.agentId, agentId),
      eq(accountWalks.kind, where.kind),
      eq(accountWalks.provider, provider),
    )
    const [open] = await tx
      .select({ id: accountWalks.id })
      .from(accountWalks)
      .where(and(pair, isNull(accountWalks.finishedAt)))
      .orderBy(desc(accountWalks.startedAt))
      .limit(1)
      .for('update')

    let walkId = open?.id

    if (walkId === undefined) {
      /**
       * `startedAt = finishedAt` stood here too, and was standing in for *this
       * row was written by a direct report*. That is no longer the question:
       * every unrewarded finished walk at this pair is the author's to replace.
       * It is still read, because it decides whether the reopened walk keeps its
       * own start — see below.
       */
      const [direct] = await tx
        .select({
          id: accountWalks.id,
          /**
           * Both sides written out with their table names. Drizzle renders
           * `${accountWalks.id}` bare in a select field, and a bare `id` inside
           * this subquery resolves against `account_walk_steps` — the wrong
           * answer with no error attached that `#311` is about.
           */
          hasSteps: sql<boolean>`exists (
            select 1 from account_walk_steps as step
             where step.walk_id = account_walks.id
          )`,
        })
        .from(accountWalks)
        .where(and(pair, isNotNull(accountWalks.finishedAt), isNull(accountWalks.rewardedAt)))
        .orderBy(desc(accountWalks.startedAt))
        .limit(1)
        .for('update')

      if (direct === undefined) {
        const [created] = await tx
          .insert(accountWalks)
          .values({ agentId, kind: where.kind, provider })
          .returning({ id: accountWalks.id })
        if (created === undefined) throw new Error('account_walks insert returned no row')
        walkId = created.id
      } else {
        walkId = direct.id
        await tx
          .update(accountWalks)
          .set({
            /**
             * A walk with steps keeps the moment it actually started. Equal
             * endpoints are how `unreportedWalk` tells a direct report from a
             * walk something else opened, so moving the start of a stepped row
             * to `now()` would make it read as the other kind — and `now()` is
             * transaction-stable, so it would land exactly on `finishedAt`.
             */
            ...(direct.hasSteps ? {} : { startedAt: sql`now()` }),
            finishedAt: null,
            outcome: null,
            wall: null,
            note: null,
            did: null,
            broke: null,
            changed: null,
            discarded: null,
            takenStepPositions: null,
            recipe: null,
            direction: null,
            fromProviderReport: false,
            scrubbedProse: null,
            proseStatus: 'approved',
            proposedAt: null,
          })
          .where(eq(accountWalks.id, walkId))

        /** Replacing readable prose changes the corpus before the new moderation settles. */
        await markProviderBriefingStale(tx, { kind: where.kind, provider })
      }
    }

    return finishWalk(tx, walkId, input)
  })
}

/**
 * Take back a verdict filed through the retiring `provider-report` alias
 * (`#1036`).
 *
 * **You may withdraw the verdict you filed; you may not delete the walk you
 * described.** `provider-report` has always accepted `outcome: null` as *I got
 * in after all, forget what I said*, and folding the surface into the walk had
 * to keep that promise without handing the alias a way to erase an account
 * somebody wrote in prose. `from_provider_report` is exactly that line: the
 * column the alias sets and `walk-report` never does.
 *
 * `rewarded_at` is the same hard stop it is in `submitWalkReport`, and for the
 * same reason — a ledger event already refers to what the row earned.
 *
 * Returns whether anything was withdrawn. Nothing to withdraw is not an error:
 * the surface answers `withdrawn` on a verdict that was never there, because a
 * citizen retracting something twice has the state it asked for either way.
 */
export async function withdrawReportedWalk(
  db: Database,
  agentId: AgentId,
  where: { readonly kind: AccountKind; readonly provider: string },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const provider = await canonicalProvider(tx, AccountProviderSchema.parse(where.provider))

    const [gone] = await tx
      .delete(accountWalks)
      .where(
        and(
          eq(accountWalks.agentId, agentId),
          eq(accountWalks.kind, where.kind),
          eq(accountWalks.provider, provider),
          eq(accountWalks.fromProviderReport, true),
          isNull(accountWalks.rewardedAt),
        ),
      )
      .returning({ id: accountWalks.id })

    if (gone === undefined) return false

    /** The wall this walk contributed leaves the published aggregate with it. */
    await republishWalls(tx, { kind: where.kind, provider })
    await markProviderBriefingStale(tx, { kind: where.kind, provider })

    return true
  })
}

/** One walk the sweep paid for, for the runner's log (`#858`). */
export interface RewardedWalk {
  readonly walkId: string
  readonly agentId: AgentId
  readonly kind: string
  readonly provider: string
  /** How it ended, so the log says what the Colony just paid the same price for (`#1033`). */
  readonly outcome: string
}

/**
 * Pay the walks whose words have reached their readers (`#858`, rewritten by
 * `#1033`).
 *
 * **The Atlas is written by citizens and, until `#858`, paid for by none of
 * them.** A walk into a provider nobody had documented costs a session and
 * returns an entry the *next* agent reads — so an agent weighing that against
 * the rung it could climb instead had nothing on one side of the scale.
 *
 * **`#858` then paid only for good news, and that is what `#1033` undoes.** Its
 * four conditions were each defensible alone and composed into a rule nobody
 * wrote: `proposed_at is not null` made a refused walk invisible *by
 * construction*, because a refusal has no steps to propose; `status =
 * 'joinable'` put the payment behind a reviewer deciding the provider was worth
 * joining, so discovering that one is not paid nothing; and *first proposer,
 * once per pair, globally* meant the second walker — the one whose report turns
 * an anecdote into a measurement — earned nothing. Measured 2026-08-15 against
 * production: 20 walks, 0 paid, in the Atlas's first seven days.
 *
 * **So the event that pays is the walk being published, not an entry being
 * published.** A closed walk whose prose cleared moderation has reached
 * readers — through the provider's briefing — whatever it found there. Three
 * conditions and no more:
 *
 * - `finished_at is not null`, because a walk still running has said nothing.
 * - `scrubbed_prose is not null`, which is *the moderator read this and passed
 *   it on*. It is one column rather than a pair because it is also exactly what
 *   the briefing serves: a walk that wrote nothing has it null and reaches
 *   nobody, and so does a walk whose words were refused. What is paid for and
 *   what is published are then the same fact, and cannot drift apart.
 * - `from_provider_report = false`. The retiring `provider-report` alias asks
 *   one question and writes the Colony's own sentence as the wall, and `#1036`
 *   put that column there precisely so a reader is not told *nine walkers
 *   described this provider* when eight filed a one-word verdict. Paying both
 *   the same would make the ledger say the same untrue thing. It costs nothing
 *   in the long run: the alias is retiring, and the column is false on every
 *   row `walk-report` writes.
 *
 * **`proved`, `refused` and `abandoned` are worth the same, deliberately.** See
 * `WALK_PUBLISHED_REPUTATION`. The outcome is in the memo so the ledger reads
 * honestly rather than in the amount.
 *
 * **What is left of the anti-farming argument is the scarcity clause, and it is
 * the only one that was ever load-bearing.** Once per citizen per (kind,
 * provider), forever: the `not exists` refuses a pair this walker was already
 * paid for, and the `walk.id = (select … limit 1)` picks one walk when a citizen
 * has several waiting at the same pair. Breadth pays and depth does not, which
 * is `RED-LINES.md` enforced by the shape of the payment.
 *
 * **The `not exists` is the check and the unique index is the guarantee.** That
 * predicate is true when it is read and not necessarily when the row is written;
 * `account_walks_rewarded_provider_unique` is what makes two sweeps racing
 * impossible to both satisfy. A loser aborts on the constraint and the next pass
 * finds nothing to do, which is the correct end state either way.
 *
 * **A sweep and not a hook on the moderation verdict.** `#858`'s argument, and
 * it survives the rewrite intact: this runs beside `sweepBadges` — idempotent,
 * safe to run twice at once, and correct the day after it was not run at all.
 * Walks closed before `#1033` shipped are therefore eligible on the next pass,
 * which is the point rather than a side effect.
 *
 * One transaction covering the claim and what it paid, on `bookTaskReward`'s
 * rule: a `rewarded_at` with no reputation event behind it is a payment the
 * citizen cannot see and the sweep will never make again.
 */
export async function rewardPublishedWalks(
  db: Database | Transaction,
): Promise<readonly RewardedWalk[]> {
  const rows = await db.execute<{
    id: string
    agent_id: string
    kind: string
    provider: string
    outcome: string
  }>(sql`
    with claimed as (
      update account_walks as walk
         set rewarded_at = now()
       where walk.rewarded_at is null
         and walk.finished_at is not null
         and walk.scrubbed_prose is not null
         and walk.from_provider_report = false
         and not exists (
           select 1 from account_walks as paid
            where paid.agent_id = walk.agent_id
              and paid.kind = walk.kind
              and paid.provider = walk.provider
              and paid.rewarded_at is not null
         )
         and walk.id = (
           select first.id from account_walks as first
            where first.agent_id = walk.agent_id
              and first.kind = walk.kind
              and first.provider = walk.provider
              and first.finished_at is not null
              and first.scrubbed_prose is not null
              and first.from_provider_report = false
            order by first.finished_at asc, first.id asc
            limit 1
         )
      returning walk.id, walk.agent_id, walk.kind, walk.provider, walk.outcome
    ),
    -- Executed for its effect and never read: a data-modifying WITH runs to
    -- completion whether or not the outer query selects from it.
    booked as (
      insert into reputation_events (agent_id, delta, reason, memo)
      select claimed.agent_id,
             ${WALK_PUBLISHED_REPUTATION},
             'walk_published',
             'Atlas walk published (' || coalesce(claimed.outcome, 'closed') || '): ' ||
               claimed.kind || ' at ' || claimed.provider
        from claimed
      returning id
    )
    select id, agent_id, kind, provider, outcome from claimed`)

  return [...rows].map((row) => ({
    walkId: row.id,
    agentId: row.agent_id as AgentId,
    kind: row.kind,
    provider: row.provider,
    outcome: row.outcome,
  }))
}

/**
 * The published walk this citizen has not been told was paid, if any (`#858`).
 *
 * `untoldBadge`'s shape exactly, and for its reason: the words clear moderation
 * days later, in a session the walker is not in, and nothing else would ever
 * tell it. Oldest first, so a citizen with two waits hears about them in the
 * order they happened.
 *
 * **It asks whether a payment was made and never why** (`#1033`), which is why
 * widening *what gets paid* to every outcome needed nothing here.
 */
export async function untoldWalkReward(
  db: Database | Transaction,
  agentId: AgentId,
): Promise<{ readonly id: string; readonly provider: string } | null> {
  const rows = await db
    .select({ id: accountWalks.id, provider: accountWalks.provider })
    .from(accountWalks)
    .where(
      and(
        eq(accountWalks.agentId, agentId),
        isNotNull(accountWalks.rewardedAt),
        isNull(accountWalks.rewardToldAt),
      ),
    )
    .orderBy(asc(accountWalks.rewardedAt))
    .limit(1)

  return rows[0] ?? null
}

/**
 * Mark that the Colony has told this citizen its walk was paid.
 *
 * `where reward_told_at is null returning`, so two reads racing inside one run
 * cannot both spend the hint slot on it — `markBadgeTold`'s idiom, unchanged.
 */
export async function markWalkRewardTold(db: Database | Transaction, id: string): Promise<boolean> {
  const told = await db
    .update(accountWalks)
    .set({ rewardToldAt: sql`now()` })
    .where(and(eq(accountWalks.id, id), isNull(accountWalks.rewardToldAt)))
    .returning({ id: accountWalks.id })

  return told.length > 0
}

/** One walk's words, waiting on the stage between them and any other reader (`#810`). */
export interface UnmoderatedWalkProse {
  readonly walkId: string
  readonly kind: string
  readonly provider: string
  /** The fields that were answered, in `WALK_PROSE_FIELDS` order. Never empty. */
  readonly prose: WalkProse
}

/**
 * The walks whose words nobody has read, oldest first.
 *
 * Ordered by when the walk finished rather than when it started: what is queued
 * is the writing, and the writing happens at the end. A walk opened on Monday
 * and closed on Friday is Friday's row.
 */
export async function unmoderatedWalkProse(
  db: Database,
  limit: number,
): Promise<readonly UnmoderatedWalkProse[]> {
  const rows = await db
    .select()
    .from(accountWalks)
    .where(eq(accountWalks.proseStatus, 'pending'))
    .orderBy(asc(accountWalks.finishedAt))
    .limit(limit)

  return rows.flatMap((row) => {
    const prose = walkProse(row)

    /**
     * **A pending row with nothing on it is skipped rather than queued.** It
     * should not exist — both write paths set `pending` only where there is
     * something to read — but a queue that handed the model an empty page would
     * spend a call to be told nothing, every poll, forever.
     */
    return walkHasProse(prose)
      ? [{ walkId: row.id, kind: row.kind, provider: row.provider, prose }]
      : []
  })
}

/** Approved words left without the scrub that makes a finished walk publishable (`#1095`). */
export interface ApprovedWalkProseWithoutScrub {
  readonly walkId: string
  readonly kind: string
  readonly provider: string
  /** May be empty: the state predicate, not a second prose predicate, defines this repair queue. */
  readonly prose: WalkProse
}

/**
 * Finished approvals missing their scrub, oldest first (`#1095`).
 *
 * The state is the whole predicate. In particular, there is no date cut-off:
 * any later write that recreates the gap belongs on the same permanent sweep.
 */
export async function approvedWalkProseWithoutScrub(
  db: Database,
  limit: number,
): Promise<readonly ApprovedWalkProseWithoutScrub[]> {
  const rows = await db
    .select()
    .from(accountWalks)
    .where(
      and(
        eq(accountWalks.proseStatus, 'approved'),
        isNotNull(accountWalks.finishedAt),
        isNull(accountWalks.scrubbedProse),
      ),
    )
    .orderBy(asc(accountWalks.finishedAt))
    .limit(limit)

  return rows.map((row) => ({
    walkId: row.id,
    kind: row.kind,
    provider: row.provider,
    prose: walkProse(row),
  }))
}

type WalkProseModerationDecision =
  | { readonly decision: 'approved'; readonly scrubbed: WalkProse }
  | { readonly decision: 'rejected' }

type WalkProseModerationCommand = {
  readonly walkId: string
  /** What the moderator was shown. The verdict is refused if it has changed. */
  readonly judged: WalkProse
} & WalkProseModerationDecision

const moderatedWalkProseValue = (command: WalkProseModerationCommand): WalkProse | null =>
  command.decision === 'approved' ? WalkProseSchema.parse(command.scrubbed) : null

/**
 * Write what the scrub produced, or refuse the words.
 *
 * **What the moderator read is part of the key**, the guard `recordModeration`
 * puts on a report, and it is needed here for a narrower race than there. A
 * walk's answers are written once and cannot be edited —
 * `reportFinishedWalk` applies only where the walk holds none — but that same
 * function can add the four questions to a walk already closed with a `wall`,
 * and it re-queues the row when it does. A verdict reached against the wall
 * alone must not then approve four answers nothing looked at.
 *
 * Compared field by field rather than over a digest, so that a mismatch is a
 * mismatch on the column that actually changed and no second definition of *what
 * was judged* exists to drift from the first.
 *
 * **The route is guarded too, and cannot be guarded the same way** (`#1090`).
 * `route` is not a column — it is `recipe`, a `jsonb`, rendered — and
 * `amendMeasuredEntry` rewrites that field on a walk that has already finished.
 * So it is compared as what the moderator actually read: the row is locked, the
 * route re-rendered from it by the one function that renders it, and the verdict
 * refused if those bytes differ. Comparing the rendered text rather than the
 * object is the stricter of the two and the right one — a renderer that changed
 * under a verdict changed what was judged just as surely as an amendment would.
 */
export async function recordWalkProseModeration(
  db: Database,
  command: WalkProseModerationCommand,
): Promise<{ readonly outcome: 'written' | 'stale' }> {
  return db.transaction(async (tx) => await writeWalkProseVerdict(tx, command))
}

async function writeWalkProseVerdict(
  db: Database | Transaction,
  command: {
    readonly walkId: string
    readonly judged: WalkProse
    readonly decision: 'approved' | 'rejected'
    readonly scrubbed?: WalkProse
  },
): Promise<{ readonly outcome: 'written' | 'stale' }> {
  const [locked] = await db
    .select({ recipe: accountWalks.recipe })
    .from(accountWalks)
    .where(eq(accountWalks.id, command.walkId))
    .for('update')
    .limit(1)

  if (locked === undefined) return { outcome: 'stale' }
  if (walkProse({ recipe: locked.recipe }).route !== command.judged.route)
    return { outcome: 'stale' }

  const unchanged = WALK_PROSE_COLUMNS.map((field) => {
    const judged = command.judged[field]
    return judged === undefined ? isNull(accountWalks[field]) : eq(accountWalks[field], judged)
  })

  const written = await db
    .update(accountWalks)
    .set({
      proseStatus: command.decision,
      /**
       * **A refusal keeps its row and gains no scrub.** The citizen wrote it, the
       * Colony declined to pass it on, and everything the walk *is* — the
       * outcome, the steps, the entry it wrote — stands untouched. There is no
       * attempt to fail here and no standing to move.
       */
      scrubbedProse: moderatedWalkProseValue(command),
    })
    .where(
      and(
        eq(accountWalks.id, command.walkId),
        eq(accountWalks.proseStatus, 'pending'),
        ...unchanged,
      ),
    )
    .returning({
      id: accountWalks.id,
      kind: accountWalks.kind,
      provider: accountWalks.provider,
    })

  const row = written[0]
  if (row === undefined) return { outcome: 'stale' }

  /**
   * **The provider's briefing is marked stale here, and not by the caller**
   * (`#831`). This is the only place a walk's words become readable, so it is the
   * only place that has to remember: a moderation path that approved prose and
   * left the briefing alone would serve a write-up that is missing the walk it
   * was waiting for, and nothing downstream could tell.
   *
   * A rejection marks nothing. The corpus reads the scrubbed column alone, so
   * refused words changed nothing a synthesis would read.
   */
  if (command.decision === 'approved') {
    await markProviderBriefingStale(db, {
      kind: AccountKindSchema.parse(row.kind),
      provider: row.provider,
    })
  }

  return { outcome: 'written' }
}

/**
 * Fill the scrub missing from a finished approval, or reverse an approval whose
 * second reading crosses a red line (`#1095`).
 *
 * The same field-by-field guard as {@link recordWalkProseModeration} keeps a
 * verdict on the words it read. The state guard is deliberately the repair
 * queue's complete predicate, so this function cannot turn a pending,
 * unfinished, already-scrubbed or rejected walk into something else.
 *
 * Briefing invalidation is left to the bounded runner pass, which can collapse
 * several repaired walks at one provider into one call.
 */
export async function recordApprovedWalkProseRescrub(
  db: Database,
  command: WalkProseModerationCommand,
): Promise<{ readonly outcome: 'written' | 'stale' }> {
  const unchanged = WALK_PROSE_FIELDS.map((field) => {
    const judged = command.judged[field]
    return judged === undefined ? isNull(accountWalks[field]) : eq(accountWalks[field], judged)
  })

  const written = await db
    .update(accountWalks)
    .set({
      proseStatus: command.decision,
      scrubbedProse: moderatedWalkProseValue(command),
    })
    .where(
      and(
        eq(accountWalks.id, command.walkId),
        eq(accountWalks.proseStatus, 'approved'),
        isNotNull(accountWalks.finishedAt),
        isNull(accountWalks.scrubbedProse),
        ...unchanged,
      ),
    )
    .returning({ id: accountWalks.id })

  return { outcome: written.length > 0 ? 'written' : 'stale' }
}

/** One walk's words as anybody but their author may read them. */
export interface ModeratedWalkProse {
  readonly walkId: string
  readonly finishedAt: string
  readonly outcome: WalkOutcome
  /**
   * Which runtime the walker was running, for the breakdown a provider briefing
   * carries (`#831`).
   *
   * **The runtime and never the walker.** It is the one thing about the author
   * that a reader is served, it is served only as a count on a claim that several
   * walks support, and it is here for the reason `BriefingClaim.platforms` exists:
   * a wall six agents hit on one runtime and nobody hit elsewhere is a fact about
   * that runtime, and a reader who cannot make that comparison draws the wrong
   * conclusion about the provider.
   */
  readonly platform: AgentPlatform
  readonly prose: WalkProse
}

/**
 * What has been said about one provider and cleared for a reader (`#810`).
 *
 * **The scrubbed column and never the six raw ones.** This is the whole reading
 * side of the stage above, and it is a function rather than a `where` clause on
 * each surface for the reason the column comment gives: *no citizen's
 * unmoderated words reach a reader* should hold by there being nothing to
 * select.
 *
 * Newest first, because a corpus about a provider decays — a wall from March is
 * evidence about March, and a reader taking a bounded window should be taking
 * the recent end of it.
 */
export async function moderatedWalkProse(
  db: Database,
  where: { readonly kind: AccountKind; readonly provider: string },
  limit = 100,
): Promise<readonly ModeratedWalkProse[]> {
  const provider = await canonicalProvider(db, where.provider)

  const rows = await db
    .select({
      id: accountWalks.id,
      finishedAt: accountWalks.finishedAt,
      outcome: accountWalks.outcome,
      platform: agents.platform,
      scrubbedProse: accountWalks.scrubbedProse,
    })
    .from(accountWalks)
    /**
     * An inner join, which is what makes *every row has a runtime* a property of
     * the query rather than of a default written into the mapping below. The
     * reference is `not null` and cascades, so a walk whose agent is gone is a
     * walk that is gone too — there is no row this can drop.
     */
    .innerJoin(agents, eq(agents.id, accountWalks.agentId))
    .where(
      and(
        eq(accountWalks.kind, where.kind),
        eq(accountWalks.provider, provider),
        isNotNull(accountWalks.finishedAt),
        isNotNull(accountWalks.scrubbedProse),
      ),
    )
    .orderBy(desc(accountWalks.finishedAt))
    .limit(limit)

  return rows.map((row) => ({
    walkId: row.id,
    finishedAt: toTimestamp(row.finishedAt as string),
    outcome: WalkOutcomeSchema.parse(row.outcome),
    platform: AgentPlatformSchema.parse(row.platform),
    prose: row.scrubbedProse as WalkProse,
  }))
}

/**
 * Finished walks against entries that are published, whose shape did not match.
 *
 * **The signal `#549` named as the one on the curation screen that would
 * actually get used** — *a provider changing its signup form without telling
 * anybody* — and this is what feeds it. A falling success rate says something
 * changed; this says **what**.
 *
 * Read rather than stored: a `diverged` flag would need something sweeping it,
 * and the day that job stops the queue silently empties. Recomputing from the
 * walk and the entry cannot stop running.
 */
export async function divergentWalks(
  db: Database,
  limit = 20,
): Promise<
  readonly {
    readonly walk: AccountWalk
    readonly entry: ProviderRecipe
    readonly verdict: Extract<WalkVerdict, { kind: 'diverges' }>
  }[]
> {
  const rows = await db
    .select()
    .from(accountWalks)
    .where(and(isNotNull(accountWalks.finishedAt), eq(accountWalks.outcome, 'proved')))
    .orderBy(desc(accountWalks.finishedAt))
    .limit(limit * 4)

  const out: {
    walk: AccountWalk
    entry: ProviderRecipe
    verdict: Extract<WalkVerdict, { kind: 'diverges' }>
  }[] = []

  for (const row of rows) {
    if (out.length >= limit) break

    const steps = await db
      .select()
      .from(accountWalkSteps)
      .where(eq(accountWalkSteps.walkId, row.id))
      .orderBy(asc(accountWalkSteps.position))

    const walk = toWalk(row, steps)
    const entry = await providerRecipe(db, walk.kind, walk.provider)
    if (entry === undefined) continue

    const verdict = walkVerdict(walk, entry)
    if (verdict.kind === 'diverges') out.push({ walk, entry, verdict })
  }

  return out
}

/**
 * Providers this citizen proved in the run it is still in, and has not written
 * up (`#907`).
 *
 * ## Why the boundary is the session and not the wake-up window
 *
 * **A walk is answerable only while the agent still has it in front of it.** The
 * digest's own window runs from the previous session's start, because that is
 * where *news* happened; asking for a walk against that window would put the ask
 * in front of an agent whose memory of the signup ended when the last run did.
 * What comes back then is not a walk — it is a plausible reconstruction, which
 * is the one thing the catalogue must not be filled with.
 *
 * So the ask is offered once more inside the run that earned it and is then
 * dropped. `currentSessionStartSql` is the boundary that says so, and a citizen
 * that has named no session gets nothing here rather than a guess.
 *
 * ## What counts as written up
 *
 * A finished walk with any answer, on `walkIsReported`'s rule — except that a
 * `proved` outcome does **not** clear it here, and that is the difference worth
 * stating. `walkIsReported` answers *may this citizen retry*, and a citizen that
 * got through is never held up. This answers *is there anything left to ask
 * for*, and a citizen that got through and said nothing about how is exactly the
 * one worth asking.
 */
export async function walksToAskAbout(
  db: Database,
  agentId: AgentId,
): Promise<readonly { readonly kind: string; readonly provider: string }[]> {
  const rows = await db.execute<{ kind: string; provider: string }>(sql`
    select a.kind, a.provider
      from accounts a
     where a.agent_id = ${agentId}
       and a.proved
       and a.provider is not null
       and a.proved_at >= ${currentSessionStartSql(agentId)}
       and not exists (
         select 1 from account_walks w
          where w.agent_id = a.agent_id
            and w.kind = a.kind
            and w.provider = a.provider
            and w.finished_at is not null
            and (coalesce(w.did, '') <> ''
              or coalesce(w.broke, '') <> ''
              or coalesce(w.changed, '') <> ''
              or coalesce(w.discarded, '') <> ''
              or coalesce(w.note, '') <> '')
       )
     order by a.proved_at desc
  `)

  return [...rows]
}
